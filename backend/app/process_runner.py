"""Cancellable, timeout-bounded OS process runner for media work.

Replaces blocking ``subprocess.run`` on long FFmpeg paths with ``Popen`` so that:

* cancel (S1 CANCELLING / lost attempt) can hard-stop the process tree mid-run;
* hard timeouts always fire even when FFmpeg hangs without reading pipes;
* stdout/stderr are drained on background threads (no pipe deadlock);
* outcomes are classified as ok / failed / cancelled / timed_out;
* optional atomic publish only renames temp → final when exit is 0 **and**
  ownership (attempt lease) is still held.

Windows: kill uses ``taskkill /T /F`` so ffmpeg children of the spawned root
are reaped — never only the shell parent. POSIX: process group + SIGKILL.
"""
from __future__ import annotations

import logging
import os
import signal
import subprocess
import sys
import threading
import time
import uuid
from collections import deque
from contextlib import contextmanager
from contextvars import ContextVar, Token
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Callable, Iterator, Sequence

class PipelineError(RuntimeError):
    """Base error for bounded media subprocess failures."""

logger = logging.getLogger(__name__)

# ── Outcomes / errors ────────────────────────────────────────────────────────


class ProcessOutcome(str, Enum):
    OK = "ok"
    FAILED = "failed"
    CANCELLED = "cancelled"
    TIMED_OUT = "timed_out"


class ProcessCancelled(Exception):
    """Cooperative or forced cancel while a child was running.

    Not a PipelineError — runner maps this to JobCancelled / CANCELLED so
    step-retry budget does not re-run a user-cancelled job.
    """

    def __init__(self, message: str = "Process was cancelled.", *, stderr_tail: str = ""):
        super().__init__(message)
        self.stderr_tail = stderr_tail
        self.outcome = ProcessOutcome.CANCELLED


class ProcessTimedOut(PipelineError):
    """Hard deadline exceeded; child tree was killed."""

    def __init__(self, message: str, *, stderr_tail: str = "", timeout: float | None = None):
        super().__init__(message)
        self.stderr_tail = stderr_tail
        self.timeout = timeout
        self.outcome = ProcessOutcome.TIMED_OUT


class ProcessFailed(PipelineError):
    """Non-zero exit (or missing expected output)."""

    def __init__(self, message: str, *, returncode: int | None = None, stderr_tail: str = ""):
        super().__init__(message)
        self.returncode = returncode
        self.stderr_tail = stderr_tail
        self.outcome = ProcessOutcome.FAILED


@dataclass(frozen=True)
class ProcessResult:
    returncode: int
    stdout: str
    stderr: str
    outcome: ProcessOutcome
    duration_sec: float
    pid: int | None = None


# ── Context-scoped cancel / ownership (wired by pipeline runner) ─────────────

CancelCheck = Callable[[], bool]
OwnershipCheck = Callable[[], bool]
SpawnObserver = Callable[[subprocess.Popen], None]

_cancel_check_var: ContextVar[CancelCheck | None] = ContextVar(
    "media_process_cancel_check", default=None
)
_ownership_check_var: ContextVar[OwnershipCheck | None] = ContextVar(
    "media_process_ownership_check", default=None
)


@contextmanager
def process_guards(
    cancel_check: CancelCheck | None = None,
    ownership_check: OwnershipCheck | None = None,
) -> Iterator[None]:
    """Bind cancel/ownership callbacks for the current context (and threads that
    inherit contextvars — the main pipeline thread only, which is enough)."""
    t1: Token = _cancel_check_var.set(cancel_check)
    t2: Token = _ownership_check_var.set(ownership_check)
    try:
        yield
    finally:
        _cancel_check_var.reset(t1)
        _ownership_check_var.reset(t2)


def current_cancel_check() -> CancelCheck | None:
    return _cancel_check_var.get()


def current_ownership_check() -> OwnershipCheck | None:
    return _ownership_check_var.get()


def _combined_cancel(
    cancel_check: CancelCheck | None,
    ownership_check: OwnershipCheck | None,
) -> CancelCheck | None:
    """True → stop. Ownership loss is treated as cancel (do not publish)."""
    ctx_cancel = cancel_check if cancel_check is not None else current_cancel_check()
    ctx_own = ownership_check if ownership_check is not None else current_ownership_check()
    if ctx_cancel is None and ctx_own is None:
        return None

    def _check() -> bool:
        if ctx_cancel is not None:
            try:
                if ctx_cancel():
                    return True
            except Exception:  # noqa: BLE001 — never block kill path on check bugs
                logger.exception("cancel_check raised; treating as cancel")
                return True
        if ctx_own is not None:
            try:
                if not ctx_own():
                    return True
            except Exception:  # noqa: BLE001
                logger.exception("ownership_check raised; treating as lost ownership")
                return True
        return False

    return _check


# ── Bounded stream drain ─────────────────────────────────────────────────────

_DEFAULT_MAX_LOG = 256 * 1024  # keep last 256 KiB of each stream


class _StreamTail:
    """Thread-safe rolling byte buffer for one pipe."""

    def __init__(self, max_bytes: int = _DEFAULT_MAX_LOG) -> None:
        self._max = max(4096, max_bytes)
        self._chunks: deque[bytes] = deque()
        self._size = 0
        self._lock = threading.Lock()
        self._done = threading.Event()

    def feed(self, data: bytes) -> None:
        if not data:
            return
        with self._lock:
            self._chunks.append(data)
            self._size += len(data)
            while self._size > self._max and self._chunks:
                dropped = self._chunks.popleft()
                self._size -= len(dropped)

    def text(self, encoding: str = "utf-8") -> str:
        with self._lock:
            raw = b"".join(self._chunks)
        return raw.decode(encoding, errors="replace")

    def mark_done(self) -> None:
        self._done.set()

    def wait(self, timeout: float | None = None) -> bool:
        return self._done.wait(timeout=timeout)


def _drain_thread(stream, tail: _StreamTail, chunk: int = 8192) -> None:
    try:
        while True:
            data = stream.read(chunk)
            if not data:
                break
            if isinstance(data, str):
                data = data.encode("utf-8", errors="replace")
            tail.feed(data)
    except Exception:  # noqa: BLE001 — reader must never kill the waiter
        logger.debug("stream drain ended with error", exc_info=True)
    finally:
        try:
            stream.close()
        except Exception:  # noqa: BLE001
            pass
        tail.mark_done()


# ── Process tree kill ────────────────────────────────────────────────────────

# PIDs we currently own (for tests / safety docs). Only kill through helpers.
_active_roots: set[int] = set()
_active_lock = threading.Lock()


def active_root_pids() -> set[int]:
    with _active_lock:
        return set(_active_roots)


def _windows_descendant_pids(root_pid: int) -> list[int]:
    """Snapshot descendants of ``root_pid`` using Toolhelp (parent-first)."""
    import ctypes
    from ctypes import wintypes

    class ProcessEntry32W(ctypes.Structure):
        _fields_ = [
            ("dwSize", wintypes.DWORD),
            ("cntUsage", wintypes.DWORD),
            ("th32ProcessID", wintypes.DWORD),
            ("th32DefaultHeapID", ctypes.c_size_t),
            ("th32ModuleID", wintypes.DWORD),
            ("cntThreads", wintypes.DWORD),
            ("th32ParentProcessID", wintypes.DWORD),
            ("pcPriClassBase", wintypes.LONG),
            ("dwFlags", wintypes.DWORD),
            ("szExeFile", wintypes.WCHAR * 260),
        ]

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
    kernel32.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
    kernel32.Process32FirstW.argtypes = [wintypes.HANDLE, ctypes.POINTER(ProcessEntry32W)]
    kernel32.Process32FirstW.restype = wintypes.BOOL
    kernel32.Process32NextW.argtypes = [wintypes.HANDLE, ctypes.POINTER(ProcessEntry32W)]
    kernel32.Process32NextW.restype = wintypes.BOOL
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel32.CloseHandle.restype = wintypes.BOOL

    snapshot = kernel32.CreateToolhelp32Snapshot(0x00000002, 0)  # TH32CS_SNAPPROCESS
    invalid_handle = ctypes.c_void_p(-1).value
    if not snapshot or ctypes.cast(snapshot, ctypes.c_void_p).value == invalid_handle:
        return []
    parent_by_pid: dict[int, int] = {}
    try:
        entry = ProcessEntry32W()
        entry.dwSize = ctypes.sizeof(entry)
        ok = kernel32.Process32FirstW(snapshot, ctypes.byref(entry))
        while ok:
            parent_by_pid[int(entry.th32ProcessID)] = int(entry.th32ParentProcessID)
            ok = kernel32.Process32NextW(snapshot, ctypes.byref(entry))
    finally:
        kernel32.CloseHandle(snapshot)

    descendants: list[int] = []
    frontier = [root_pid]
    seen = {root_pid}
    while frontier:
        parent = frontier.pop(0)
        children = [pid for pid, ppid in parent_by_pid.items() if ppid == parent and pid not in seen]
        descendants.extend(children)
        seen.update(children)
        frontier.extend(children)
    return descendants


def _terminate_windows_pid(pid: int) -> None:
    """Best-effort native TerminateProcess, used when taskkill is denied."""
    import ctypes
    from ctypes import wintypes

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.TerminateProcess.argtypes = [wintypes.HANDLE, wintypes.UINT]
    kernel32.TerminateProcess.restype = wintypes.BOOL
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel32.CloseHandle.restype = wintypes.BOOL
    handle = kernel32.OpenProcess(0x0001, False, pid)  # PROCESS_TERMINATE
    if not handle:
        return
    try:
        kernel32.TerminateProcess(handle, 1)
    finally:
        kernel32.CloseHandle(handle)


def _kill_posix_process_group(proc: subprocess.Popen, grace_sec: float) -> None:
    """Terminate a new-session process group, including orphaned descendants."""
    pid = proc.pid
    try:
        os.killpg(pid, signal.SIGTERM)
    except (ProcessLookupError, PermissionError, OSError):
        try:
            proc.terminate()
        except Exception:  # noqa: BLE001
            pass
    deadline = time.monotonic() + grace_sec
    while proc.poll() is None and time.monotonic() < deadline:
        time.sleep(0.05)

    # The group can outlive its leader. Checking only proc.poll() here leaks a
    # grandchild that inherited pipes/GPU handles after the supervisor exited.
    try:
        os.killpg(pid, 0)
        group_alive = True
    except (ProcessLookupError, PermissionError, OSError):
        group_alive = False
    if group_alive:
        try:
            os.killpg(pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError, OSError):
            pass
    elif proc.poll() is None:
        try:
            proc.kill()
        except Exception:  # noqa: BLE001
            pass


def kill_process_tree(proc: subprocess.Popen, *, grace_sec: float = 2.0) -> None:
    """Hard-stop ``proc`` and all descendants.

    Windows: ``taskkill /PID <pid> /T /F`` (tree). Does **not** use
    ``proc.kill()`` alone — that can leave ffmpeg children orphaned when a
    shell or multi-process tree is involved.

    POSIX: SIGTERM then SIGKILL to the process group started with
    ``start_new_session=True``.
    """
    if proc.poll() is not None:
        return
    pid = proc.pid
    logger.info("killing process tree pid=%s platform=%s", pid, sys.platform)
    try:
        if sys.platform == "win32":
            # Snapshot first: after killing the root, orphaned descendants may
            # no longer be discoverable through its parent PID.
            descendants = _windows_descendant_pids(pid)
            # /T = tree, /F = force. Ignore non-zero (already exited).
            subprocess.run(
                ["taskkill", "/PID", str(pid), "/T", "/F"],
                capture_output=True,
                text=True,
                # Cancellation is on the interactive path. A wedged taskkill
                # must not freeze the API/worker for 30 seconds; the exception
                # fallback below still force-kills the root process.
                timeout=max(0.5, min(float(grace_sec), 3.0)),
            )
            # Restricted/embedded Windows tokens can make taskkill return
            # Access denied even for our own child. Native leaf-to-root
            # termination is the deterministic fallback.
            for child_pid in reversed(descendants):
                _terminate_windows_pid(child_pid)
            if proc.poll() is None:
                try:
                    proc.kill()
                except Exception:  # noqa: BLE001
                    _terminate_windows_pid(pid)
        else:
            _kill_posix_process_group(proc, grace_sec)
    except Exception:  # noqa: BLE001
        logger.exception("kill_process_tree failed for pid=%s", pid)
        try:
            proc.kill()
        except Exception:  # noqa: BLE001
            pass
    try:
        proc.wait(timeout=max(0.5, min(float(grace_sec), 3.0)))
    except Exception:  # noqa: BLE001
        # taskkill can return non-zero without raising (for example when its
        # process-tree snapshot races startup). Never return while the root is
        # still alive, otherwise run_process waits another 15 seconds and pipe
        # drain threads remain blocked indefinitely.
        try:
            proc.kill()
            proc.wait(timeout=max(0.5, min(float(grace_sec), 3.0)))
        except Exception:  # noqa: BLE001
            logger.exception("root process remained alive after tree kill pid=%s", pid)


def pid_alive(pid: int) -> bool:
    """Best-effort: is OS process still running?"""
    if pid <= 0:
        return False
    if sys.platform == "win32":
        # Avoid spawning/localization-parsing ``tasklist`` on every poll. It can
        # report false negatives under load and has itself hung on some Windows
        # installations. Querying the process handle is fast and locale-free.
        import ctypes

        process_query_limited_information = 0x1000
        still_active = 259
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        handle = kernel32.OpenProcess(process_query_limited_information, False, pid)
        if not handle:
            return False
        try:
            exit_code = ctypes.c_ulong()
            if not kernel32.GetExitCodeProcess(handle, ctypes.byref(exit_code)):
                return False
            return exit_code.value == still_active
        finally:
            kernel32.CloseHandle(handle)
    try:
        os.kill(pid, 0)
        return True
    except (ProcessLookupError, PermissionError, OSError):
        return False


# ── Timeouts ─────────────────────────────────────────────────────────────────

DEFAULT_HARD_CAP_SEC = 6 * 3600  # 6h absolute ceiling
DEFAULT_BASE_SEC = 120.0
DEFAULT_PER_MEDIA_SEC = 4.0  # seconds of wall time per second of media


def media_timeout(
    duration_sec: float | None = None,
    *,
    base: float = DEFAULT_BASE_SEC,
    per_sec: float = DEFAULT_PER_MEDIA_SEC,
    hard_cap: float = DEFAULT_HARD_CAP_SEC,
    minimum: float = 30.0,
) -> float:
    """Wall-clock timeout for a media encode roughly proportional to duration."""
    if duration_sec is None or duration_sec <= 0:
        return min(hard_cap, max(minimum, base * 2))
    return min(hard_cap, max(minimum, base + float(duration_sec) * per_sec))


# ── Core runner ──────────────────────────────────────────────────────────────

def run_process(
    cmd: Sequence[str],
    *,
    timeout: float | None = None,
    cancel_check: CancelCheck | None = None,
    ownership_check: OwnershipCheck | None = None,
    on_spawn: SpawnObserver | None = None,
    cwd: str | Path | None = None,
    env: dict[str, str] | None = None,
    poll_interval: float = 0.15,
    max_log_bytes: int = _DEFAULT_MAX_LOG,
    text: bool = True,  # kept for call-site familiarity; we always decode tails
    raise_on_error: bool = True,
) -> ProcessResult:
    """Run ``cmd`` with Popen, cancel polling, timeout, and safe pipe drain.

    On cancel/timeout the whole process tree is killed. Raises
    ``ProcessCancelled`` / ``ProcessTimedOut`` / ``ProcessFailed`` when
    ``raise_on_error`` is True (default).
    """
    del text  # tails always decoded as utf-8 with replace
    if not cmd:
        raise ValueError("run_process requires a non-empty command")

    stop = _combined_cancel(cancel_check, ownership_check)
    # Pre-flight cancel so we never spawn if already stopping.
    if stop is not None and stop():
        raise ProcessCancelled("Cancelled before spawning the process.")

    popen_kwargs: dict = {
        "stdout": subprocess.PIPE,
        "stderr": subprocess.PIPE,
        "cwd": str(cwd) if cwd is not None else None,
        "env": env,
    }
    if sys.platform == "win32":
        # New process group aids isolation; tree kill still uses taskkill /T.
        create_flag = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
        popen_kwargs["creationflags"] = create_flag
    else:
        popen_kwargs["start_new_session"] = True

    t0 = time.monotonic()
    try:
        proc = subprocess.Popen(list(cmd), **popen_kwargs)
    except FileNotFoundError as exc:
        raise ProcessFailed(
            f"Command not found: {cmd[0]}", returncode=None, stderr_tail=str(exc)
        ) from exc

    with _active_lock:
        _active_roots.add(proc.pid)
    if on_spawn is not None:
        try:
            on_spawn(proc)
        except Exception:  # noqa: BLE001 - observability must not leak the child
            logger.exception("process spawn observer failed pid=%s", proc.pid)

    out_tail = _StreamTail(max_log_bytes)
    err_tail = _StreamTail(max_log_bytes)
    readers = [
        threading.Thread(
            target=_drain_thread, args=(proc.stdout, out_tail),
            name=f"stdout-{proc.pid}", daemon=True,
        ),
        threading.Thread(
            target=_drain_thread, args=(proc.stderr, err_tail),
            name=f"stderr-{proc.pid}", daemon=True,
        ),
    ]
    for th in readers:
        th.start()

    outcome = ProcessOutcome.OK
    try:
        while True:
            rc = proc.poll()
            if rc is not None:
                # An external cancel endpoint may tree-kill the process before
                # this polling thread observes the cancel flag.  Classify that
                # race as cancellation, not as a failed command.
                if stop is not None and stop():
                    outcome = ProcessOutcome.CANCELLED
                break
            if stop is not None and stop():
                outcome = ProcessOutcome.CANCELLED
                kill_process_tree(proc)
                break
            if timeout is not None and timeout > 0:
                if (time.monotonic() - t0) >= timeout:
                    outcome = ProcessOutcome.TIMED_OUT
                    kill_process_tree(proc)
                    break
            time.sleep(poll_interval)
        # Ensure reaped
        try:
            proc.wait(timeout=15)
        except Exception:  # noqa: BLE001
            kill_process_tree(proc)
    finally:
        for th in readers:
            th.join(timeout=5)
        with _active_lock:
            _active_roots.discard(proc.pid)

    duration = time.monotonic() - t0
    stdout = out_tail.text()
    stderr = err_tail.text()
    returncode = proc.returncode if proc.returncode is not None else -1

    if outcome == ProcessOutcome.CANCELLED:
        result = ProcessResult(
            returncode=returncode, stdout=stdout, stderr=stderr,
            outcome=outcome, duration_sec=duration, pid=proc.pid,
        )
        if raise_on_error:
            raise ProcessCancelled(
                f"Process cancelled (pid={proc.pid}, {duration:.1f}s).",
                stderr_tail=stderr[-800:],
            )
        return result

    if outcome == ProcessOutcome.TIMED_OUT:
        result = ProcessResult(
            returncode=returncode, stdout=stdout, stderr=stderr,
            outcome=outcome, duration_sec=duration, pid=proc.pid,
        )
        if raise_on_error:
            raise ProcessTimedOut(
                f"Process timed out after {timeout:.0f}s (pid={proc.pid}).",
                stderr_tail=stderr[-800:],
                timeout=timeout,
            )
        return result

    # Natural exit
    if returncode != 0:
        result = ProcessResult(
            returncode=returncode, stdout=stdout, stderr=stderr,
            outcome=ProcessOutcome.FAILED, duration_sec=duration, pid=proc.pid,
        )
        if raise_on_error:
            raise ProcessFailed(
                f"Process exited with code {returncode}: {stderr.strip()[:400] or '(no stderr)'}",
                returncode=returncode,
                stderr_tail=stderr[-800:],
            )
        return result

    return ProcessResult(
        returncode=returncode, stdout=stdout, stderr=stderr,
        outcome=ProcessOutcome.OK, duration_sec=duration, pid=proc.pid,
    )


# ── Atomic publish helper ────────────────────────────────────────────────────

def temp_path_for(final: Path, *, tag: str | None = None) -> Path:
    """Sibling temp path in the same directory (same volume → atomic replace)."""
    suffix = final.suffix or ""
    token = tag or uuid.uuid4().hex[:10]
    return final.with_name(f".{final.stem}.{token}.part{suffix}")


def publish_atomic(temp: Path, final: Path, *, ownership_check: OwnershipCheck | None = None) -> Path:
    """Rename temp → final only if ownership still holds; else delete temp."""
    own = ownership_check if ownership_check is not None else current_ownership_check()
    if own is not None:
        try:
            if not own():
                temp.unlink(missing_ok=True)
                raise ProcessCancelled(
                    f"Ownership lost — {final.name} was not published."
                )
        except ProcessCancelled:
            raise
        except Exception:  # noqa: BLE001
            temp.unlink(missing_ok=True)
            raise ProcessCancelled(f"Ownership check failed — {final.name} was not published.")
    if not temp.exists() or temp.stat().st_size == 0:
        temp.unlink(missing_ok=True)
        raise ProcessFailed(f"Temporary output is empty or missing: {temp.name}")
    final.parent.mkdir(parents=True, exist_ok=True)
    # On Windows, Path.replace overwrites destination when possible.
    temp.replace(final)
    return final


def discard_temp(temp: Path | None) -> None:
    if temp is None:
        return
    try:
        temp.unlink(missing_ok=True)
    except OSError:
        logger.debug("discard_temp failed for %s", temp, exc_info=True)


def run_to_file(
    cmd: Sequence[str],
    final_path: Path,
    *,
    timeout: float | None = None,
    cancel_check: CancelCheck | None = None,
    ownership_check: OwnershipCheck | None = None,
    cwd: str | Path | None = None,
    env: dict[str, str] | None = None,
    output_arg_index: int = -1,
    poll_interval: float = 0.15,
) -> Path:
    """Run a command that writes its last (or indexed) arg as the output file.

    The output path in ``cmd`` is rewritten to a sibling ``.part`` file; on
    success + ownership the part is atomically published to ``final_path``.
    Cancel/fail/timeout always unlink the part and never leave a complete-looking
    final produced by a failed attempt (existing final is left untouched).
    """
    cmd_list = list(cmd)
    if not cmd_list:
        raise ValueError("empty command")
    idx = output_arg_index if output_arg_index >= 0 else len(cmd_list) + output_arg_index
    if idx < 0 or idx >= len(cmd_list):
        raise ValueError(f"output_arg_index {output_arg_index} out of range for cmd")

    temp = temp_path_for(final_path)
    cmd_list[idx] = str(temp.resolve() if hasattr(temp, "resolve") else temp)
    # Prefer absolute for the part path so cwd changes (font dir) cannot misplace it.
    cmd_list[idx] = str(Path(cmd_list[idx]).resolve())

    try:
        run_process(
            cmd_list,
            timeout=timeout,
            cancel_check=cancel_check,
            ownership_check=ownership_check,
            cwd=cwd,
            env=env,
            poll_interval=poll_interval,
            raise_on_error=True,
        )
        return publish_atomic(temp, final_path, ownership_check=ownership_check)
    except (ProcessCancelled, ProcessTimedOut, ProcessFailed):
        discard_temp(temp)
        raise
    except Exception:
        discard_temp(temp)
        raise


def run_ffmpeg(
    cmd: Sequence[str],
    *,
    final_path: Path | None = None,
    timeout: float | None = None,
    duration_sec: float | None = None,
    cancel_check: CancelCheck | None = None,
    ownership_check: OwnershipCheck | None = None,
    cwd: str | Path | None = None,
) -> ProcessResult | Path:
    """Convenience: default media timeout; optional atomic file publish.

    When ``final_path`` is set, returns the published ``Path``.
    Otherwise returns ``ProcessResult`` (e.g. null mux / loudnorm measure).
    """
    if timeout is None:
        timeout = media_timeout(duration_sec)
    if final_path is not None:
        return run_to_file(
            cmd,
            final_path,
            timeout=timeout,
            cancel_check=cancel_check,
            ownership_check=ownership_check,
            cwd=cwd,
        )
    return run_process(
        cmd,
        timeout=timeout,
        cancel_check=cancel_check,
        ownership_check=ownership_check,
        cwd=cwd,
        raise_on_error=True,
    )
