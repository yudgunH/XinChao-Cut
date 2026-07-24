"""Text-to-speech endpoint (OmniVoice, isolated subprocess).

OmniVoice's deps (transformers>=5, numpy 2, torch>=2.4) are incompatible with the
WhisperX/Demucs tier in the main venv, so it is NEVER imported here. Instead we
run app/tts_worker.py in a SEPARATE interpreter (`.venv-omnivoice`) as a
subprocess and exchange small JSON files. The main backend stays clean.

Endpoints:
  POST   /tts                     start a synthesis job (texts[] → one wav each)
  GET    /tts/{id}                job status (reads the worker's progress.json)
  GET    /tts/{id}/download/{i}   the i-th synthesized wav
  POST   /tts/{id}/cancel        cancel a running job
  GET    /tts/voices             built-in presets + saved (cloned) voices
  POST   /tts/voices             create a saved voice from an uploaded sample
  DELETE /tts/voices/{id}        delete a saved voice
"""
from __future__ import annotations

import atexit
import json
import logging
import os
import re
import shutil
import subprocess
import threading
import time
import uuid
from dataclasses import dataclass
from typing import Callable, Optional

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse

from ..config import BACKEND_ROOT, get_settings
from ..export.job import safe_rmtree_jobdir
from ..utils import save_upload_bounded
from ..ffmpeg_utils import ffmpeg_available
from ..resource_coordinator import GPU_JOB_SEMAPHORE as HEAVY_JOB_SEMAPHORE

log = logging.getLogger(__name__)
router = APIRouter(prefix="/tts", tags=["tts"])

MAX_JOBS = 10
# The OmniVoice worker runs in the ISOLATED .venv-omnivoice interpreter as a
# subprocess, launched via a top-level SOURCE shim (`-m tts_worker_entry`) — NOT
# by file path and NOT as app.tts_worker directly. Reason: when the backend ships
# obfuscated, `app/` is a single compiled Nuitka app.pyd that `python -m` can't
# launch; the source shim stays runnable and forwards into app.tts_worker.main().
_WORKER_MODULE = "tts_worker_entry"

# Voice-design presets → an `instruct` built ONLY from OmniVoice's fixed
# attribute vocabulary (male/female, child..elderly, {very low..very high} pitch,
# whisper, <x> accent). Spoken language is auto-detected from the text.
PRESETS: dict[str, dict] = {
    "narrator-f": {"name": "Female — narrator", "gender": "female", "language": "multi", "instruct": "female, middle-aged, moderate pitch"},
    "narrator-m": {"name": "Male — deep narrator", "gender": "male", "language": "multi", "instruct": "male, middle-aged, low pitch"},
    "energetic-f": {"name": "Female — young and bright", "gender": "female", "language": "multi", "instruct": "female, young adult, high pitch"},
    "energetic-m": {"name": "Male — young and energetic", "gender": "male", "language": "multi", "instruct": "male, young adult, high pitch"},
    "us-f": {"name": "Female — American accent", "gender": "female", "language": "en", "instruct": "female, american accent"},
    "british-m": {"name": "Male — British accent", "gender": "male", "language": "en", "instruct": "male, british accent"},
}

VOICE_GENDERS = {"male", "female", "unknown"}
VOICE_LANGUAGES = {"vi", "en", "ja", "ko", "de", "zh", "multi", "unknown"}
VOICE_LANGUAGE_BY_ID = {
    "voice_cc706bf16e": "en",
    "voice_842a742632": "vi",
    "voice_a80428ae68": "ja",
    "voice_b51302abf1": "ko",
    "voice_a671d47c68": "de",
    "voice_26d04c9109": "ko",
    "voice_edd82ab435": "ko",
    "voice_c9230ca89f": "en",
    "voice_e2a2173669": "en",
    "voice_6a96f62e8b": "ko",
    "voice_fddabcc99d": "de",
    "voice_caf2604e76": "de",
    "voice_b1cdc9fd68": "de",
    "voice_3734c14463": "de",
    "voice_9ba707d6a4": "ja",
}


def _normalize_gender(gender: str | None) -> str:
    value = (gender or "").strip().lower()
    return value if value in VOICE_GENDERS else "unknown"


def _normalize_voice_language(language: str | None) -> str:
    value = (language or "").strip().lower()
    aliases = {
        "jp": "ja",
        "jpn": "ja",
        "japanese": "ja",
        "kr": "ko",
        "kor": "ko",
        "korean": "ko",
        "ger": "de",
        "deu": "de",
        "german": "de",
        "eng": "en",
        "english": "en",
        "vn": "vi",
        "vie": "vi",
        "vietnamese": "vi",
        "cn": "zh",
        "chi": "zh",
        "chinese": "zh",
    }
    value = aliases.get(value, value)
    return value if value in VOICE_LANGUAGES else "unknown"


def _voice_language(voice_id: str, entry: dict) -> str:
    explicit = _normalize_voice_language(entry.get("language"))
    if explicit != "unknown":
        return explicit
    known = VOICE_LANGUAGE_BY_ID.get(voice_id)
    if known:
        return known
    name = (entry.get("name") or "").lower()
    if any(mark in name for mark in ("(en)", "english", "brian", "adam", "kristen", "us", "british")):
        return "en"
    if any(mark in name for mark in ("(kr)", "(ko)", "korean", "yooni", "annie", "theo")):
        return "ko"
    if any(mark in name for mark in ("(jp)", "(ja)", "japanese", "kano")):
        return "ja"
    if any(mark in name for mark in ("(ger)", "(de)", "german", "turbo tim")):
        return "de"
    if any(mark in name for mark in ("ngọc", "huyền", "(vi)", "vietnam")):
        return "vi"
    return "unknown"


def _omnivoice_python() -> Optional[str]:
    """Resolve the interpreter that has omnivoice installed."""
    cand = get_settings().omnivoice_python or os.environ.get("XINCHAO_OMNIVOICE_PYTHON", "")
    if cand and os.path.exists(cand):
        return cand
    # Default to a dedicated venv next to the backend.
    base = os.path.join(BACKEND_ROOT, ".venv-omnivoice")
    for sub in ("Scripts/python.exe", "bin/python"):
        p = os.path.join(base, *sub.split("/"))
        if os.path.exists(p):
            return p
    return None


def _worker_env() -> dict:
    """Environment for the worker subprocess: keep the OmniVoice/HF model cache
    inside the project (tts_hf_home) instead of the C: drive's ~/.cache."""
    hf = os.path.abspath(get_settings().tts_hf_home)
    os.makedirs(hf, exist_ok=True)
    return {
        **os.environ,
        "HF_HOME": hf,
        # Windows blocks symlink creation without admin/Developer Mode, so HF's
        # cache symlinking dies with "[WinError 1314] A required privilege is not
        # held". Copy files into the cache instead — slightly more disk, but it
        # actually works on a normal Windows account.
        "HF_HUB_DISABLE_SYMLINKS": "1",
        "HF_HUB_DISABLE_SYMLINKS_WARNING": "1",
        # Chống phân mảnh VRAM trên 8GB. Windows KHÔNG hỗ trợ expandable_segments
        # nên allocator hay phình + giữ khối lớn → tạo-giọng (OmniVoice + Whisper
        # nội bộ) có thể đội lên ~7GB, chạm trần card → CUDA tràn sang shared memory
        # (RAM qua PCIe) → CHẬM GẤP NHIỀU LẦN / treo. max_split_size + GC sớm giảm
        # giữ-khối; trả VRAM về OS thay vì ôm khối lớn không dùng.
        "PYTORCH_CUDA_ALLOC_CONF": "garbage_collection_threshold:0.7,max_split_size_mb:256",
    }


_avail_cache: tuple[float, bool] | None = None


def tts_available() -> bool:
    """True when the omnivoice interpreter exists and the package is installed.

    Probe = a LIGHTWEIGHT `find_spec('omnivoice')` (just locates the package,
    does NOT import it). A full `import omnivoice` pulls in torch + transformers 5
    + CUDA init and routinely takes 20-40s cold — it blew the old 20s timeout right
    after backend boot → false "offline" for a minute. find_spec is sub-second.
    Cached: success 60s, failure only 15s so a transient miss recovers fast."""
    global _avail_cache
    now = time.time()
    if _avail_cache:
        ts, cached_ok = _avail_cache
        if now - ts < (60 if cached_ok else 15):
            return cached_ok
    py = _omnivoice_python()
    ok = False
    if py:
        try:
            r = subprocess.run(
                [py, "-c", "import importlib.util,sys; sys.exit(0 if importlib.util.find_spec('omnivoice') else 1)"],
                capture_output=True, timeout=15,
            )
            ok = r.returncode == 0
        except Exception:  # noqa: BLE001
            ok = False
    _avail_cache = (now, ok)
    return ok


# ── Saved-voice registry ───────────────────────────────────────────────────

def _voices_dir() -> str:
    d = os.path.abspath(get_settings().tts_voices_dir)
    os.makedirs(d, exist_ok=True)
    return d


def _registry_path() -> str:
    return os.path.join(_voices_dir(), "voices.json")


# Serializes every load→mutate→save of voices.json so concurrent create/rename/
# delete/preview-lazy-save requests cannot drop each other's entries.
_REGISTRY_LOCK = threading.Lock()
_PREVIEW_CACHE_LOCK = threading.Lock()
_PREVIEW_CACHE_INFLIGHT: set[str] = set()
_SAVED_VOICE_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,128}$")


def _safe_voice_artifact_path(raw: object) -> str:
    """Resolve a registry path and fail closed outside the voice root."""
    value = str(raw or "").strip()
    if not value:
        return ""
    root = os.path.realpath(_voices_dir())
    candidate = os.path.realpath(os.path.abspath(os.path.expanduser(value)))
    try:
        if os.path.commonpath([root, candidate]) != root or candidate == root:
            return ""
    except (OSError, ValueError):
        return ""
    return candidate


def _remove_voice_artifacts(*paths: object) -> None:
    """Best-effort rollback, but never unlink outside the voice root."""
    for raw in paths:
        path = _safe_voice_artifact_path(raw)
        if not path:
            continue
        try:
            os.remove(path)
        except FileNotFoundError:
            pass
        except OSError:
            log.warning("Could not remove voice artifact %s", path, exc_info=True)


def _publish_copy_atomic(source: str, destination: str) -> None:
    """Copy to a sibling temp and expose only a complete file."""
    target = os.path.abspath(destination)
    os.makedirs(os.path.dirname(target), exist_ok=True)
    temporary = f"{target}.{uuid.uuid4().hex}.part"
    try:
        shutil.copyfile(source, temporary)
        os.replace(temporary, target)
    finally:
        try:
            os.remove(temporary)
        except OSError:
            pass


def _load_registry() -> dict[str, dict]:
    try:
        with open(_registry_path(), encoding="utf-8") as f:
            payload = json.load(f)
        if not isinstance(payload, dict):
            return {}
        return {
            voice_id: entry
            for voice_id, entry in payload.items()
            if isinstance(voice_id, str)
            and _SAVED_VOICE_ID_RE.fullmatch(voice_id)
            and isinstance(entry, dict)
        }
    except Exception:  # noqa: BLE001
        return {}


def _save_registry(reg: dict[str, dict]) -> None:
    tmp = _registry_path() + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(reg, f, ensure_ascii=False)
    os.replace(tmp, _registry_path())


# ── Resident OmniVoice worker ──────────────────────────────────────────────
# Keeping the model loaded between jobs avoids the ~3 s reload (+ VRAM churn)
# every synthesis paid. One worker, serialized by a lock (the model isn't
# concurrent-safe and a single GPU wants one job at a time). Evicted after an
# idle period so the ~2 GB VRAM is returned when TTS isn't in use.

WORKER_IDLE_TTL = 120  # seconds idle before the resident model is unloaded
#                        (kept short so the ~2GB VRAM returns soon for the other
#                         GPU tasks — whisper/demucs/export — on a shared card)
WORKER_JOB_TIMEOUT = 600  # hard cap per job so a stuck worker can't wedge the
#                           shared GPU semaphore (which would block export/etc.)
WORKER_CANCEL_GRACE = 20  # cooperative cancel grace before force-freeing VRAM
SYNTH_JOB_TIMEOUT = 150   # tighter cap for a single-text synth, including cold load
#                           (~12s) + the longest segment + atempo is well under
#                           this, so a stuck OmniVoice generate fails in ~2.5min
#                           instead of freezing the pipeline for the full 10min.
SEMAPHORE_ACQUIRE_TIMEOUT = 900  # never block forever on the shared GPU semaphore —
#                                  a leaked/stuck permit must surface as an error.
CREATE_VOICE_TIMEOUT = 420  # clone-prompt creation should finish in a few minutes;
#                             cap it so a bad sample cannot pin CUDA indefinitely.
CREATE_VOICE_MIN_FREE_MB = 5200  # RTX 8GB: create_prompt has a high transient peak.
#                                  Starting with ~3GB free still spills into shared
#                                  memory and looks like the app is frozen.


def _read_status(path: str) -> Optional[dict]:
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:  # noqa: BLE001
        return None


def _write_status(path: str, data: dict) -> None:
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f)
    os.replace(tmp, path)


def _kill_process_tree(proc: subprocess.Popen) -> None:
    """Best-effort child-tree cleanup for Windows venv launcher processes."""
    from ..process_runner import kill_process_tree

    kill_process_tree(proc)


def _run_worker_oneshot(args: list[str], *, timeout: float) -> subprocess.CompletedProcess:
    """Run an OmniVoice one-shot and reliably reap it on timeout.

    `subprocess.run(..., timeout=...)` kills only the direct process. On Windows a
    venv python can leave the real interpreter child alive, which keeps CUDA/VRAM
    pinned after the request has already failed.
    """
    proc = subprocess.Popen(
        args,
        cwd=BACKEND_ROOT,
        env=_worker_env(),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    try:
        stdout, stderr = proc.communicate(timeout=timeout)
    except subprocess.TimeoutExpired as e:
        _kill_process_tree(proc)
        stdout, stderr = proc.communicate()
        raise subprocess.TimeoutExpired(args, timeout, output=stdout, stderr=stderr) from e
    return subprocess.CompletedProcess(args, proc.returncode, stdout, stderr)


def _rotate_worker_log(path: str, max_bytes: int = 20 * 1024 * 1024, backups: int = 3) -> None:
    """Bound the resident worker stderr log before starting a new process."""
    try:
        if os.path.getsize(path) < max_bytes:
            return
    except OSError:
        return
    try:
        oldest = f"{path}.{backups}"
        if os.path.exists(oldest):
            os.remove(oldest)
        for idx in range(backups - 1, 0, -1):
            src, dst = f"{path}.{idx}", f"{path}.{idx + 1}"
            if os.path.exists(src):
                os.replace(src, dst)
        os.replace(path, f"{path}.1")
    except OSError as exc:
        log.warning("Could not rotate TTS worker log: %s", exc)


class _WorkerManager:
    def __init__(self) -> None:
        self._proc: Optional[subprocess.Popen] = None
        self._lock = threading.Lock()
        self._last_used = 0.0
        threading.Thread(target=self._idle_watch, daemon=True).start()

    def _alive(self) -> bool:
        return self._proc is not None and self._proc.poll() is None

    def _start(self, py: str) -> None:
        # Never leave two OmniVoice processes alive (BrokenPipe restart used to
        # spawn a new worker without reaping the old one → 2× VRAM).
        if self._alive():
            self._shutdown_locked()
        assert self._proc is None or self._proc.poll() is not None

        # 8GB headroom: free a LARGE resident WhisperX (~3-4GB) + FunASR (~1.5GB)
        # before OmniVoice (2GB) loads, else caption→voice overflows the card →
        # thrash. Small whisper coexists fine so it's left alone. Once per worker
        # lifecycle, not per job.
        from . import transcribe
        transcribe.free_asr_vram(only_if_large=True)
        # VRAM gate: with the big whisper evicted, make sure the card (incl. other
        # processes on the machine) has room for OmniVoice before we spawn it.
        # OmniVoice has no usable CPU path, so if VRAM never frees we fail with a
        # clear message rather than thrashing the GPU for everyone.
        from .. import gpu_guard
        if not gpu_guard.wait_for_vram(gpu_guard.NEED_OMNIVOICE, kind="tts"):
            raise RuntimeError(
                "Not enough VRAM for TTS — the GPU is busy with another process. Try again later."
            )
        work = os.path.abspath(os.path.join(get_settings().work_dir, "tts"))
        os.makedirs(work, exist_ok=True)
        log_path = os.path.join(work, "worker.log")
        _rotate_worker_log(log_path)
        logf = open(log_path, "a", encoding="utf-8")
        logf.write(f"\n--- worker start {time.strftime('%Y-%m-%d %H:%M:%S')} ---\n")
        logf.flush()
        self._proc = subprocess.Popen(
            [py, "-m", _WORKER_MODULE, "serve"],
            cwd=BACKEND_ROOT,  # so `app` is importable when run via -m
            env=_worker_env(),
            stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=logf,
            text=True, bufsize=1,
        )

    def _send(self, cmd: str, spec_path: str) -> None:
        assert self._proc and self._proc.stdin
        self._proc.stdin.write(json.dumps({"cmd": cmd, "spec_path": spec_path}) + "\n")
        self._proc.stdin.flush()

    def submit(
        self, py: str, cmd: str, spec_path: str, status_file: str,
        timeout: float = WORKER_JOB_TIMEOUT,
        *,
        cancel_check: Callable[[], bool] | None = None,
        cancel_file: str | None = None,
    ) -> None:
        """Run one job on the resident worker, blocking until its status file
        reports a terminal state. Restarts the worker once if the pipe is dead.
        `timeout` caps how long a single job may run before the worker is killed."""
        with self._lock:
            # Starting the worker can fail the VRAM gate (GPU busy with other
            # processes) → surface it as a normal job error the poller reads,
            # not an unhandled exception.
            try:
                if not self._alive():
                    self._start(py)
            except RuntimeError as e:
                _write_status(status_file, {"status": "error", "error": str(e)[:300]})
                return
            # Clear a stale status file so we wait on THIS run, not a prior one.
            try:
                os.remove(status_file)
            except OSError:
                pass
            try:
                self._send(cmd, spec_path)
            except (BrokenPipeError, OSError):
                # Tree-kill the dead/wedged worker BEFORE spawning a replacement
                # so we never hold two OmniVoice models in VRAM.
                self._shutdown_locked()
                try:
                    self._start(py)
                except RuntimeError as e:
                    _write_status(status_file, {"status": "error", "error": str(e)[:300]})
                    return
                self._send(cmd, spec_path)

            deadline = time.time() + timeout
            cancel_sent = False
            cancel_deadline: float | None = None
            while True:
                st = _read_status(status_file)
                if st and st.get("status") in ("done", "error", "cancelled"):
                    self._last_used = time.time()
                    return
                if cancel_check is not None and cancel_check() and not cancel_sent:
                    # Cooperative stop: do not release the shared GPU permit
                    # until the worker acknowledges terminal status. Releasing
                    # immediately would let another CUDA job overlap the current
                    # line while OmniVoice is still running.
                    cancel_sent = True
                    cancel_deadline = time.time() + WORKER_CANCEL_GRACE
                    if cancel_file:
                        try:
                            open(cancel_file, "a", encoding="utf-8").close()
                        except OSError:
                            log.warning("Could not write TTS cancel flag %s", cancel_file)
                if cancel_sent and cancel_deadline is not None and time.time() > cancel_deadline:
                    # model.generate() itself is not cooperatively cancellable.
                    # Kill after a short grace so a cancelled long sentence does
                    # not hold VRAM/the shared GPU permit for the full timeout.
                    self._shutdown_locked()
                    _write_status(status_file, {"status": "cancelled", "error": None})
                    self._last_used = time.time()
                    return
                if not self._alive():
                    _write_status(status_file, {
                        "status": "error", "error": "OmniVoice worker exited unexpectedly (see worker.log)",
                    })
                    self._last_used = time.time()
                    return
                if time.time() > deadline:
                    # Stuck worker — kill it (frees VRAM + this wait) so it can't
                    # hold the shared GPU semaphore and block other backend tasks.
                    self._shutdown_locked()
                    _write_status(status_file, {"status": "error", "error": "TTS timed out"})
                    return
                time.sleep(0.2)

    def _idle_watch(self) -> None:
        while True:
            time.sleep(30)
            with self._lock:
                if self._alive() and self._last_used and time.time() - self._last_used > WORKER_IDLE_TTL:
                    self._shutdown_locked()

    def _shutdown_locked(self) -> None:
        """Tree-kill + wait the resident worker. Must run under self._lock."""
        proc = self._proc
        self._proc = None
        if not proc:
            return
        try:
            if proc.stdin:
                proc.stdin.close()
        except Exception:  # noqa: BLE001
            pass
        # Always tree-kill (not bare terminate): Windows venv launcher can leave
        # the real interpreter child holding CUDA after the parent exits.
        _kill_process_tree(proc)
        try:
            proc.wait(timeout=5)
        except Exception:  # noqa: BLE001
            pass

    def shutdown(self) -> None:
        with self._lock:
            self._shutdown_locked()

    def shutdown_if_idle(self) -> bool:
        """Evict the resident OmniVoice worker ONLY if no job is running (the lock
        is free). Non-blocking: never waits behind a synth and never tree-kills a
        worker mid-job. Used by the captioner to reclaim VRAM for a large whisper."""
        if not self._lock.acquire(blocking=False):
            return False  # a synth is in flight — leave it loaded
        try:
            self._shutdown_locked()
            return True
        finally:
            self._lock.release()


_WORKER_MGR = _WorkerManager()
atexit.register(_WORKER_MGR.shutdown)


# ── Synthesis jobs ─────────────────────────────────────────────────────────

@dataclass
class TtsJob:
    id: str
    out_dir: str
    total: int
    cancelled: bool = False
    started_at: float = 0.0  # epoch when synthesis began (for ETA)

    def read_progress(self) -> dict:
        # The resident worker (or one-shot) writes progress.json; a fatal worker
        # failure is written there too by the synth runner below.
        p = _read_status(os.path.join(self.out_dir, "progress.json"))
        if self.cancelled:
            terminal = p is not None and p.get("status") in ("cancelled", "done", "error")
            if not terminal:
                done = (p or {}).get("done", 0)
                total = (p or {}).get("total", self.total) or self.total
                return {
                    "id": self.id, "status": "cancelling", "pct": round(100.0 * done / max(1, total), 1),
                    "done": done, "total": total, "error": None,
                }
        if p is None:
            return {"id": self.id, "status": "queued", "pct": 0.0, "done": 0, "total": self.total, "error": None}
        done, total = p.get("done", 0), p.get("total", self.total) or self.total
        return {
            "id": self.id,
            "status": p.get("status", "running"),
            "pct": round(100.0 * done / max(1, total), 1),
            "done": done,
            "total": total,
            "error": p.get("error"),
        }


JOBS: dict[str, TtsJob] = {}
# See export/job.py for the pattern: guards structural mutations only.
_JOBS_LOCK = threading.Lock()


def _request_job_cancel(job: TtsJob) -> None:
    job.cancelled = True
    try:
        open(os.path.join(job.out_dir, "cancel"), "w").close()
    except OSError:
        pass


def shutdown_active_jobs() -> int:
    """Stop queued synths and hard-reap the resident TTS worker.

    Normal user cancellation stays cooperative so the hot model can be reused.
    Process shutdown is different: no later request can reuse that worker, and
    leaving it alive keeps its CUDA context (and sometimes its child process)
    after uvicorn has stopped accepting requests.
    """
    with _JOBS_LOCK:
        jobs = list(JOBS.values())
    active: list[TtsJob] = []
    for job in jobs:
        try:
            status = job.read_progress().get("status")
        except Exception:  # noqa: BLE001 - shutdown must remain best effort
            status = "running"
        if status in ("queued", "loading", "running", "cancelling"):
            active.append(job)
            _request_job_cancel(job)
    _WORKER_MGR.shutdown()
    return len(active)


def _prune() -> None:
    victims: list[str] = []
    with _JOBS_LOCK:
        if len(JOBS) <= MAX_JOBS:
            return
        for jid in list(JOBS.keys()):
            if len(JOBS) <= MAX_JOBS:
                break
            job = JOBS[jid]
            if job.read_progress().get("status") in ("queued", "loading", "running", "cancelling"):
                continue  # still active
            victims.append(job.out_dir)
            del JOBS[jid]
    for out_dir in victims:
        safe_rmtree_jobdir(out_dir)


def _spawn_synth(job: TtsJob, py: str, spec_path: str) -> None:
    """Hand the job to the resident worker in a thread, serialized against other
    heavy GPU jobs (export/separate) via the shared semaphore."""
    status_file = os.path.join(job.out_dir, "progress.json")

    def runner() -> None:
        if not HEAVY_JOB_SEMAPHORE.acquire(
            timeout=None,
            cancel_check=lambda: job.cancelled,
        ):
            _write_status(
                status_file,
                {"status": "cancelled", "error": None}
                if job.cancelled
                else {"status": "error", "error": "TTS waited too long for the GPU semaphore."},
            )
            return
        try:
            if job.cancelled:
                _write_status(status_file, {"status": "cancelled", "error": None})
                return
            job.started_at = time.time()
            _WORKER_MGR.submit(
                py,
                "synth",
                spec_path,
                status_file,
                cancel_check=lambda: job.cancelled,
                cancel_file=os.path.join(job.out_dir, "cancel"),
            )
        except Exception as e:  # noqa: BLE001
            _write_status(status_file, {"status": "error", "error": str(e)[:500]})
        finally:
            HEAVY_JOB_SEMAPHORE.release()

    threading.Thread(target=runner, daemon=True).start()


def known_voice(voice: str) -> bool:
    """True if `voice` is a usable voice id — a built-in preset or a saved clone
    whose prompt file still exists. Used by callers to validate a
    user-chosen voice before queueing."""
    if voice in PRESETS:
        return True
    entry = _load_registry().get(voice)
    prompt_path = _safe_voice_artifact_path((entry or {}).get("promptPath"))
    return bool(prompt_path and os.path.isfile(prompt_path))


def _resolve_voice_spec(voice: str) -> tuple[Optional[str], Optional[str]]:
    """(instruct, clone_prompt_path) for a voice id: preset → instruct; saved
    clone → prompt path; unknown/empty → the configured default preset."""
    if voice in PRESETS:
        return PRESETS[voice]["instruct"], None
    entry = _load_registry().get(voice)
    prompt_path = _safe_voice_artifact_path((entry or {}).get("promptPath"))
    if prompt_path and os.path.isfile(prompt_path):
        return None, prompt_path
    default = get_settings().tts_default_voice
    if default in PRESETS:
        return PRESETS[default]["instruct"], None
    return None, None


def _synth_to_file_with_spec(
    text: str,
    out_wav: str,
    *,
    instruct: Optional[str] = None,
    clone_prompt_path: Optional[str] = None,
    language: Optional[str] = None,
    speed: Optional[float] = None,
) -> None:
    py = _omnivoice_python()
    if not py or not tts_available():
        raise RuntimeError(
            "OmniVoice is unavailable — create .venv-omnivoice and run `pip install omnivoice`, "
            "or set XINCHAO_OMNIVOICE_PYTHON."
        )
    work = os.path.abspath(os.path.join(get_settings().work_dir, "tts", "request_" + uuid.uuid4().hex[:10]))
    os.makedirs(work, exist_ok=True)
    spec_path = os.path.join(work, "spec.json")
    with open(spec_path, "w", encoding="utf-8") as f:
        json.dump({
            "texts": [text], "instruct": instruct, "clone_prompt_path": clone_prompt_path,
            "language": language or None, "speed": speed or None, "out_dir": work,
        }, f)
    status_file = os.path.join(work, "progress.json")
    if not HEAVY_JOB_SEMAPHORE.acquire(timeout=None):
        safe_rmtree_jobdir(work)
        raise RuntimeError("TTS waited too long for the GPU — another GPU task may be stuck.")
    try:
        _WORKER_MGR.submit(py, "synth", spec_path, status_file, timeout=SYNTH_JOB_TIMEOUT)
    finally:
        HEAVY_JOB_SEMAPHORE.release()
    st = _read_status(status_file) or {}
    if st.get("status") != "done":
        safe_rmtree_jobdir(work)
        raise RuntimeError(f"TTS failed: {st.get('error') or st.get('status') or 'unknown'}")
    produced = os.path.join(work, "0.wav")
    if not os.path.exists(produced):
        safe_rmtree_jobdir(work)
        raise RuntimeError("The TTS worker did not create a WAV file.")
    try:
        _publish_copy_atomic(produced, out_wav)
    finally:
        safe_rmtree_jobdir(work)


def synth_to_file(
    text: str, out_wav: str, *, voice: str = "", language: Optional[str] = None,
    speed: Optional[float] = None,
) -> None:
    """Synchronously synthesize ONE text → out_wav (24 kHz mono) on the resident
    OmniVoice worker. For in-process callers: shares the
    SAME worker + HEAVY_JOB_SEMAPHORE as the editor's TTS, so OmniVoice is loaded
    exactly once on the single GPU. Blocks until done. Raises on failure.
    """
    instruct, clone_prompt_path = _resolve_voice_spec(voice)
    _synth_to_file_with_spec(
        text,
        out_wav,
        instruct=instruct,
        clone_prompt_path=clone_prompt_path,
        language=language,
        speed=speed,
    )


# Same reasoning as translate.py: bound the job before spending GPU minutes.
# Per-line cap matters MORE here than in translate: OmniVoice generates one
# audio clip per input, and a single ~200k-char line would push the worker into
# a multi-minute autoregressive decode that regularly OOMs the 8 GB GPU. 3 KiB
# is comfortably above the longest natural narration line we've seen (~600
# chars for a full paragraph) while still failing fast on abuse.
_TTS_MAX_LINES = 500
_TTS_MAX_LINE_CHARS = 3000
_TTS_MAX_TOTAL_CHARS = 200_000


@router.post("")
def start_tts(
    texts: str = Form(...),
    voice: str = Form(""),
    speed: float = Form(0.0),
    language: str = Form(""),
) -> dict:
    # Validate input BEFORE probing OmniVoice so an over-sized request always
    # fails cheaply — even on a machine where the model isn't installed.
    try:
        lines = [str(t) for t in json.loads(texts) if str(t).strip()]
    except Exception:
        raise HTTPException(status_code=422, detail="`texts` must be a JSON array of strings")
    if not lines:
        raise HTTPException(status_code=422, detail="No non-empty text to synthesize")
    if len(lines) > _TTS_MAX_LINES:
        raise HTTPException(status_code=422, detail=f"Too many texts (>{_TTS_MAX_LINES}).")
    for i, line in enumerate(lines):
        if len(line) > _TTS_MAX_LINE_CHARS:
            raise HTTPException(
                status_code=422,
                detail=f"texts[{i}] too long ({len(line)}>{_TTS_MAX_LINE_CHARS}).",
            )
    total = sum(len(line) for line in lines)
    if total > _TTS_MAX_TOTAL_CHARS:
        raise HTTPException(status_code=422, detail=f"Texts too long ({total}>{_TTS_MAX_TOTAL_CHARS}).")

    py = _omnivoice_python()
    if not py or not tts_available():
        raise HTTPException(
            status_code=503,
            detail="OmniVoice not available. Create .venv-omnivoice and `pip install omnivoice`, "
                   "or set XINCHAO_OMNIVOICE_PYTHON.",
        )

    # Resolve the voice: preset → instruct; saved voice → clone prompt; else auto.
    instruct: Optional[str] = None
    clone_prompt_path: Optional[str] = None
    if voice in PRESETS:
        instruct = PRESETS[voice]["instruct"]
    else:
        entry = _load_registry().get(voice)
        if entry and os.path.exists(entry.get("promptPath", "")):
            clone_prompt_path = entry["promptPath"]

    _prune()
    jid = uuid.uuid4().hex[:12]
    work = os.path.abspath(os.path.join(get_settings().work_dir, "tts", jid))
    os.makedirs(work, exist_ok=True)
    spec_path = os.path.join(work, "spec.json")
    with open(spec_path, "w", encoding="utf-8") as f:
        json.dump({
            "texts": lines, "instruct": instruct, "clone_prompt_path": clone_prompt_path,
            "speed": speed or None, "language": language.strip() or None, "out_dir": work,
        }, f)

    job = TtsJob(id=jid, out_dir=work, total=len(lines))
    with _JOBS_LOCK:
        JOBS[jid] = job
    _spawn_synth(job, py, spec_path)
    return {"jobId": jid}


@router.get("/voices")
def voices() -> dict:
    items = [
        {
            "id": vid,
            "name": meta["name"],
            "type": "preset",
            "gender": _normalize_gender(meta.get("gender")),
            "language": _voice_language(vid, meta),
        }
        for vid, meta in PRESETS.items()
    ]
    for vid, entry in _load_registry().items():
        preview_meta = _voice_preview_meta(vid, entry)
        items.append({
            "id": vid, "name": entry["name"], "type": "clone",
            "gender": _normalize_gender(entry.get("gender")),
            "language": _voice_language(vid, entry),
            "hasPreview": preview_meta["hasPreview"],
            "previewVersion": preview_meta["previewVersion"],
        })
    return {"voices": items}


REF_MAX_SECONDS = 10  # cap mẫu clone: encode VRAM ∝ độ dài → >~10s OOM trên card 8GB.
VOICE_SAMPLE_MAX_BYTES = 128 * 1024 * 1024


def _ref_seconds(path: str) -> float:
    """Độ dài (giây) của wav qua header — khỏi cần ffprobe."""
    import contextlib
    import wave
    try:
        with contextlib.closing(wave.open(path, "rb")) as w:
            return w.getnframes() / float(w.getframerate() or 1)
    except Exception:  # noqa: BLE001
        return 0.0


def _prep_reference(raw: str, ref_wav: str) -> bool:
    """Chuẩn hoá mẫu clone → mono 24kHz, BỎ khoảng lặng ĐẦU, rồi CẮT còn
    REF_MAX_SECONDS giây tiếng nói thật. Mẫu dài làm encode clone-prompt phình VRAM
    (~+0.3GB/giây → OOM/thrash trên 8GB) và OmniVoice cũng chỉ cần 3-10s. Trả True
    nếu ra file dùng được, False nếu hỏng/rỗng.

    Both ffmpeg invocations are hard-capped at 60s: the input is user-uploaded and a
    hung ffmpeg would otherwise pin a FastAPI worker thread forever. Timeout → False
    (callers map that to HTTP 422).
    """
    base = ["ffmpeg", "-y", "-i", raw, "-vn", "-ac", "1", "-ar", "24000"]
    # Pass 1: cắt lặng ĐẦU (chỉ 1 đoạn) → 10s sau đó là tiếng thật, không phí budget.
    trim = ["-af", "silenceremove=start_periods=1:start_threshold=-40dB:start_silence=0.05"]
    try:
        subprocess.run(
            base + trim + ["-t", str(REF_MAX_SECONDS), ref_wav],
            capture_output=True,
            text=True,
            timeout=60,
        )
    except subprocess.TimeoutExpired:
        return False
    if _ref_seconds(ref_wav) >= 1.5:
        return True
    # Fallback: bộ lọc lặng ăn quá nhiều (mẫu nhỏ tiếng) → chỉ cắt độ dài, giữ nguyên.
    try:
        subprocess.run(
            base + ["-t", str(REF_MAX_SECONDS), ref_wav],
            capture_output=True,
            text=True,
            timeout=60,
        )
    except subprocess.TimeoutExpired:
        return False
    return _ref_seconds(ref_wav) >= 0.3


@router.post("/voices/transcribe-sample")
def transcribe_sample(ref: UploadFile = File(...)) -> dict:
    """Phiên âm mẫu giọng (đã trim ≤10s) bằng WhisperX → UI điền sẵn ref-text cho
    user SỬA cho đúng. User chỉnh chính xác → vừa căn chuẩn clone, vừa để create
    khỏi nạp Whisper của OmniVoice (nhanh + nhẹ VRAM). WhisperX thiếu → trả rỗng."""
    if not ffmpeg_available():
        raise HTTPException(status_code=503, detail="ffmpeg not found (needed to read the sample)")
    tmp = os.path.join(get_settings().work_dir, "tts", "_refprobe_" + uuid.uuid4().hex[:8])
    os.makedirs(tmp, exist_ok=True)
    raw = os.path.join(tmp, "in" + (os.path.splitext(ref.filename or "")[1] or ".dat"))
    wav = os.path.join(tmp, "ref.wav")
    try:
        save_upload_bounded(ref, raw, max_bytes=VOICE_SAMPLE_MAX_BYTES)
        if not _prep_reference(raw, wav):
            raise HTTPException(status_code=422, detail="The sample could not be read or contains almost no audible speech.")
        from .transcribe import run_transcription_sync, whisperx_available
        if not whisperx_available():
            return {"text": ""}  # không có WhisperX → user tự gõ
        # Force the SMALL model regardless of the configured whisper_model: the
        # sample is ≤10s and the user edits the text anyway, while a configured
        # large-v2 would load ~4GB into THIS process for it — and the CUDA
        # context + allocator reserve never fully return to the OS on Windows,
        # permanently shrinking the VRAM budget of every later GPU job.
        result = run_transcription_sync(wav, model_name="small", language=None)
        text = " ".join((c.get("content") or "") for c in result.get("cues", [])).strip()
        return {"text": text}
    finally:
        # This route is only a one-off helper for the clone wizard. Keeping
        # WhisperX resident after a 10s sample steals VRAM from the immediately
        # following create-voice request, so evict it right away instead of
        # waiting for the normal idle TTL.
        try:
            from . import transcribe
            transcribe.release_models()
        except Exception:  # noqa: BLE001
            pass
        safe_rmtree_jobdir(tmp)


@router.post("/voices")
def create_voice(
    name: str = Form(...),
    gender: str = Form("unknown"),
    language: str = Form("unknown"),
    refText: str = Form(""),
    ref: UploadFile = File(...),
) -> dict:
    """Build a reusable cloned voice from an uploaded audio sample. Synchronous
    (runs in FastAPI's threadpool): spawns the worker, waits, registers it."""
    py = _omnivoice_python()
    if not py or not tts_available():
        raise HTTPException(status_code=503, detail="OmniVoice not available")
    if not ffmpeg_available():
        raise HTTPException(status_code=503, detail="ffmpeg not found (needed to read the sample)")
    ref_text_input = refText.strip()
    if not ref_text_input:
        raise HTTPException(
            status_code=422,
            detail="Enter the sample transcript or run recognition before saving the voice.",
        )

    vid = "voice_" + uuid.uuid4().hex[:10]
    vdir = _voices_dir()
    raw = os.path.join(vdir, f"{vid}.input")
    save_upload_bounded(ref, raw, max_bytes=VOICE_SAMPLE_MAX_BYTES)
    ref_wav = os.path.join(vdir, f"{vid}.ref.wav")
    # Chuẩn hoá + trim thông minh (bỏ lặng đầu, cắt ≤10s) — xem _prep_reference:
    # encode clone-prompt ngốn VRAM tỉ lệ độ dài mẫu (20s → ~8.5GB → tràn 8GB).
    try:
        ok_ref = _prep_reference(raw, ref_wav)
    except BaseException:
        _remove_voice_artifacts(ref_wav)
        raise
    finally:
        _remove_voice_artifacts(raw)
    if not ok_ref:
        _remove_voice_artifacts(ref_wav)
        raise HTTPException(
            status_code=422,
            detail="The sample could not be read or contains almost no speech after silence trimming.",
        )

    prompt_path = os.path.join(vdir, f"{vid}.pt")
    spec_path = os.path.join(vdir, f"{vid}.spec.json")
    voice_language = _normalize_voice_language(language)
    preview_path = _voice_preview_path(prompt_path, voice_language)

    # Voice creation is rare and heavy — serialize it against other GPU jobs.
    if not HEAVY_JOB_SEMAPHORE.acquire(timeout=None):
        _remove_voice_artifacts(ref_wav, prompt_path, spec_path, preview_path)
        raise HTTPException(status_code=503, detail="The GPU has been busy too long. Try again later.")
    try:
        # FREE VRAM FIRST (8GB card): create-voice spawns its OWN process that loads
        # OmniVoice (2GB) + Whisper ASR (1.6GB). If the resident synth worker (another
        # 2GB OmniVoice) or a WhisperX model is still in VRAM, the card overflows →
        # CUDA spills to shared RAM → 10-30 min thrash. We hold HEAVY_JOB_SEMAPHORE so
        # no synth runs now → safe to evict the idle resident worker + whisper.
        _WORKER_MGR.shutdown()
        try:
            from . import transcribe
            transcribe.release_models()
        except Exception:  # noqa: BLE001
            pass
        # Voice-clone prompt alignment (CRITICAL for quality): require the exact
        # sample transcript from the user or from the explicit "Nhận diện" button.
        # Letting OmniVoice auto-transcribe here loads its internal ASR inside the
        # create process and can push 8GB cards into shared-memory thrash.
        ref_text = ref_text_input

        # Admission control must happen AFTER evicting our own resident models,
        # but BEFORE the one-shot process loads CUDA. Create-voice has a higher
        # peak than normal synth because it may load OmniVoice's internal ASR and
        # then encode reference audio tokens; starting it with <~3GB free on an
        # 8GB card spills into shared RAM and looks like a multi-minute hang.
        from .. import gpu_guard
        need_mb = max(CREATE_VOICE_MIN_FREE_MB, gpu_guard.NEED_OMNIVOICE + 600)
        if not gpu_guard.wait_for_vram(need_mb, kind="tts-create-voice"):
            raise HTTPException(
                status_code=503,
                detail="Not enough VRAM to save the cloned voice. Close other GPU tasks and try again.",
            )

        with open(spec_path, "w", encoding="utf-8") as f:
            json.dump({
                "ref_wav": ref_wav, "ref_text": ref_text, "prompt_path": prompt_path,
                # Do not synth the preview inside the save request. On 8GB cards
                # the prompt can be ready while preview generation still thrashes
                # for minutes; /voices/{id}/preview already lazily creates and
                # caches this file when the user actually presses play.
            }, f)

        # ONE-SHOT subprocess: when it exits all its VRAM (OmniVoice) is freed —
        # nothing left pinned, and it never bloats the resident synth worker.
        proc = _run_worker_oneshot(
            [py, "-m", _WORKER_MODULE, "create-voice", spec_path],
            timeout=CREATE_VOICE_TIMEOUT,
        )
    except subprocess.TimeoutExpired:
        _remove_voice_artifacts(ref_wav, prompt_path, spec_path, preview_path)
        raise HTTPException(status_code=504, detail="Voice creation timed out (the process was killed; VRAM freed)")
    except BaseException:
        _remove_voice_artifacts(ref_wav, prompt_path, spec_path, preview_path)
        raise
    finally:
        HEAVY_JOB_SEMAPHORE.release()

    if not os.path.exists(prompt_path):
        st = _read_status(os.path.join(vdir, "create_result.json")) or {}
        detail = st.get("error") or (proc.stderr or "")[-800:] or "Voice creation failed"
        _remove_voice_artifacts(ref_wav, prompt_path, spec_path, preview_path)
        raise HTTPException(status_code=500, detail=detail[-800:])

    try:
        with _REGISTRY_LOCK:
            reg = _load_registry()
            reg[vid] = {
                "name": name.strip() or vid, "promptPath": prompt_path,
                "gender": _normalize_gender(gender),
                "language": voice_language,
                "sampleText": ref_text,
                "previewPath": preview_path if os.path.exists(preview_path) else None,
                "createdAt": int(time.time() * 1000),
            }
            _save_registry(reg)
            saved = dict(reg[vid])
    except BaseException:
        _remove_voice_artifacts(ref_wav, prompt_path, spec_path, preview_path)
        raise
    _start_voice_preview_cache_job(vid, prompt_path, preview_path)
    return {
        "id": vid,
        "name": saved["name"],
        "type": "clone",
        "gender": saved["gender"],
        "language": _voice_language(vid, saved),
    }


@router.patch("/voices/{voice_id}")
def rename_voice(
    voice_id: str,
    name: str = Form(...),
    gender: str = Form(""),
    language: str = Form(""),
) -> dict:
    new_name = name.strip()
    if not new_name:
        raise HTTPException(status_code=400, detail="Name required")
    with _REGISTRY_LOCK:
        reg = _load_registry()
        entry = reg.get(voice_id)
        if not entry:
            raise HTTPException(status_code=404, detail="Voice not found")
        entry["name"] = new_name
        if gender:
            entry["gender"] = _normalize_gender(gender)
        if language:
            entry["language"] = _normalize_voice_language(language)
            # A language change means the canonical preview file changes too.
            # Drop the old pointer so /preview regenerates the correct text.
            entry["previewPath"] = None
        _save_registry(reg)
        saved = dict(entry)
    return {
        "id": voice_id, "name": new_name, "type": "clone",
        "gender": _normalize_gender(saved.get("gender")),
        "language": _voice_language(voice_id, saved),
    }


@router.delete("/voices/{voice_id}")
def delete_voice(voice_id: str) -> dict:
    with _REGISTRY_LOCK:
        reg = _load_registry()
        entry = reg.pop(voice_id, None)
        if entry:
            _save_registry(reg)
    if entry:
        prompt_path = _safe_voice_artifact_path(entry.get("promptPath"))
        preview_paths: list[str] = []
        if prompt_path:
            base, _ext = os.path.splitext(prompt_path)
            parent = os.path.dirname(prompt_path) or "."
            prefix = os.path.basename(base) + ".preview"
            try:
                preview_paths = [
                    os.path.join(parent, name)
                    for name in os.listdir(parent)
                    if name.startswith(prefix) and name.endswith(".wav")
                ]
            except OSError:
                preview_paths = []
        _remove_voice_artifacts(
            prompt_path,
            prompt_path.replace(".pt", ".ref.wav"),
            prompt_path.replace(".pt", ".spec.json"),
            entry.get("previewPath"),
            *preview_paths,
        )
    return {"ok": True}


# Câu mẫu mặc định cho file "nghe thử" lazy (giọng cũ chưa có preview.wav).
PREVIEW_SAMPLE_TEXT = "Hello, this is a preview of my saved voice."
PREVIEW_SAMPLE_TEXT_BY_LANGUAGE = {
    "vi": "Hello, this is a preview of my saved voice.",
    "en": "Hello, this is my saved voice preview.",
    "ja": "こんにちは、これは保存した声のプレビューです。",
    "ko": "안녕하세요, 저장된 목소리 미리듣기입니다.",
    "de": "Hallo, dies ist eine Vorschau meiner gespeicherten Stimme.",
    "zh": "你好，这是我保存的声音预览。",
    "multi": "Hello, this is my saved voice preview.",
    "unknown": "Hello, this is my saved voice preview.",
}


def _preview_sample_text(voice_id: str, entry: dict | None = None) -> str:
    entry = entry or {}
    language = _voice_language(voice_id, entry or {})
    if language == "unknown":
        sample_text = (entry.get("sampleText") or "").strip()
        if not sample_text:
            prompt_path = _safe_voice_artifact_path(entry.get("promptPath"))
            spec_path = prompt_path.replace(".pt", ".spec.json") if prompt_path else ""
            try:
                with open(spec_path, encoding="utf-8") as f:
                    sample_text = (json.load(f).get("ref_text") or "").strip()
            except Exception:  # noqa: BLE001
                sample_text = ""
        if sample_text:
            return sample_text[:300]
    return PREVIEW_SAMPLE_TEXT_BY_LANGUAGE.get(language, PREVIEW_SAMPLE_TEXT_BY_LANGUAGE["unknown"])


def _voice_preview_path(prompt_path: str, language: str) -> str:
    prompt_path = _safe_voice_artifact_path(prompt_path)
    if not prompt_path:
        return ""
    base, _ext = os.path.splitext(prompt_path)
    lang = _normalize_voice_language(language)
    if lang == "unknown":
        lang = "sample"
    return f"{base}.preview.{lang}.wav"


def _voice_preview_path_for_entry(voice_id: str, entry: dict) -> str:
    return _voice_preview_path(entry.get("promptPath", ""), _voice_language(voice_id, entry))


def _voice_preview_meta(voice_id: str, entry: dict) -> dict:
    preview_path = _voice_preview_path_for_entry(voice_id, entry)
    if preview_path and os.path.exists(preview_path):
        return {
            "hasPreview": True,
            "previewVersion": int(os.path.getmtime(preview_path) * 1000),
        }
    return {"hasPreview": False, "previewVersion": 0}


def _voice_preview_response(voice_id: str, preview_path: str) -> FileResponse:
    return FileResponse(
        preview_path,
        media_type="audio/wav",
        filename=f"{voice_id}_preview.wav",
        headers={"Cache-Control": "no-store, max-age=0"},
    )


def _start_voice_preview_cache_job(voice_id: str, prompt_path: str, preview_path: str) -> None:
    """Create the saved preview WAV in the background.

    The save request should return as soon as the clone prompt is ready. Preview
    synthesis is useful cache work, but it is still a GPU TTS job; doing it
    inline was the reason "Lưu giọng" could sit spinning after the `.pt` already
    existed. This thread uses the normal resident worker + heavy-job semaphore,
    so it queues behind other GPU jobs and updates voices.json only on success.
    """
    def runner() -> None:
        try:
            if os.path.exists(preview_path):
                return
            if not os.path.exists(prompt_path):
                return
            with _REGISTRY_LOCK:
                reg_entry = dict(_load_registry().get(voice_id) or {})
            _synth_to_file_with_spec(
                _preview_sample_text(voice_id, reg_entry),
                preview_path,
                clone_prompt_path=prompt_path,
            )
            with _REGISTRY_LOCK:
                reg = _load_registry()
                entry = reg.get(voice_id)
                if not entry:
                    try:
                        os.remove(preview_path)
                    except OSError:
                        pass
                    return
                registered_prompt = _safe_voice_artifact_path(entry.get("promptPath"))
                if registered_prompt and os.path.isfile(registered_prompt):
                    entry["previewPath"] = preview_path
                    _save_registry(reg)
        except Exception as e:  # noqa: BLE001
            log.warning("Voice preview cache generation failed for %s: %s", voice_id, e)
        finally:
            with _PREVIEW_CACHE_LOCK:
                _PREVIEW_CACHE_INFLIGHT.discard(voice_id)

    # Reserve before Thread.start(): an immediate preview GET must observe the
    # in-flight job instead of racing a second lazy synthesis onto the GPU.
    with _PREVIEW_CACHE_LOCK:
        if voice_id in _PREVIEW_CACHE_INFLIGHT:
            return
        _PREVIEW_CACHE_INFLIGHT.add(voice_id)
    try:
        threading.Thread(
            target=runner,
            daemon=True,
            name=f"voice-preview-cache-{voice_id[-6:]}",
        ).start()
    except BaseException:
        with _PREVIEW_CACHE_LOCK:
            _PREVIEW_CACHE_INFLIGHT.discard(voice_id)
        raise


@router.get("/voices/{voice_id}/preview")
def voice_preview(voice_id: str):
    """Serve file nghe thử đã lưu của một giọng clone. Giọng cũ chưa có file →
    synth 1 lần (resident worker, an toàn semaphore) rồi cache + serve. Bấm nghe
    thử vì thế gần như tức thì, không tạo lại giọng mỗi lần."""
    reg = _load_registry()
    entry = reg.get(voice_id)
    if not entry:
        raise HTTPException(status_code=404, detail="Voice not found")
    prompt_path = _safe_voice_artifact_path(entry.get("promptPath"))
    if not prompt_path or not os.path.isfile(prompt_path):
        raise HTTPException(status_code=404, detail="Voice prompt unavailable")
    preview_path = (
        _voice_preview_path_for_entry(voice_id, entry)
        or _safe_voice_artifact_path(entry.get("previewPath"))
        or _safe_voice_artifact_path(prompt_path.replace(".pt", ".preview.wav"))
    )
    if os.path.exists(preview_path) and entry.get("previewPath") != preview_path:
        with _REGISTRY_LOCK:
            reg = _load_registry()
            saved = reg.get(voice_id)
            if saved:
                saved["previewPath"] = preview_path
                _save_registry(reg)
    if not preview_path or not os.path.exists(preview_path):
        # If the post-create background cache job is already producing this
        # preview, don't queue a duplicate TTS job. Wait briefly for the cache
        # file, then fall back to the lazy path below if the worker failed.
        deadline = time.time() + 45
        while time.time() < deadline:
            with _PREVIEW_CACHE_LOCK:
                inflight = voice_id in _PREVIEW_CACHE_INFLIGHT
            if not inflight:
                break
            if preview_path and os.path.exists(preview_path):
                break
            time.sleep(0.25)
        if preview_path and os.path.exists(preview_path):
            return _voice_preview_response(voice_id, preview_path)
        # Cache job STILL running past the wait window (cold worker load + queue
        # behind other GPU jobs can exceed it). Starting the lazy synth now would
        # queue a SECOND TTS job for the same file — tell the client to retry
        # instead of doubling the GPU work.
        with _PREVIEW_CACHE_LOCK:
            still_inflight = voice_id in _PREVIEW_CACHE_INFLIGHT
        if still_inflight:
            raise HTTPException(
                status_code=503,
                detail="The voice preview is being generated. Try again in a few seconds.",
                headers={"Retry-After": "10"},
            )
        # Lazy: dựng file nghe thử bằng giọng này rồi lưu lại.
        if not preview_path:
            raise HTTPException(status_code=404, detail="Preview unavailable")
        try:
            # Synth outside the registry lock — can take seconds; holding the lock
            # would block concurrent create/rename/delete.
            synth_to_file(_preview_sample_text(voice_id, entry), preview_path, voice=voice_id)
        except Exception as e:  # noqa: BLE001
            raise HTTPException(status_code=503, detail=f"Unable to create the voice preview: {e}")
        with _REGISTRY_LOCK:
            reg = _load_registry()
            entry = reg.get(voice_id)
            if entry:
                entry["previewPath"] = preview_path
                _save_registry(reg)
    return _voice_preview_response(voice_id, preview_path)


@router.get("/{job_id}")
async def tts_status(job_id: str) -> dict:
    job = JOBS.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return job.read_progress()


@router.post("/{job_id}/cancel")
async def tts_cancel(job_id: str) -> dict:
    job = JOBS.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    # Cooperative cancel: the resident worker checks this flag between lines and
    # stops without being killed (which would drop the model for everyone else).
    _request_job_cancel(job)
    return {"ok": True}


@router.get("/{job_id}/download/{index}")
async def tts_download(job_id: str, index: int):
    job = JOBS.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    path = os.path.join(job.out_dir, f"{index}.wav")
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail="Audio not ready")
    return FileResponse(path, media_type="audio/wav", filename=f"voice_{index}.wav")
