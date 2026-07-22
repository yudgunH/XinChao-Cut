"""Standalone child-process supervisor used by chunked exports.

It emits a synthetic FFmpeg ``out_time_us`` stream covering the whole timeline,
so the existing job runner can report progress without knowing about chunks.
"""
from __future__ import annotations

import json
import os
import re
import signal
import shutil
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Callable

OUT_US = re.compile(r"out_time_us=(\d+)")
OUT_HMS = re.compile(r"out_time=(\d+):(\d+):(\d+\.\d+)")
_ACTIVE: set[subprocess.Popen] = set()
_ACTIVE_LOCK = threading.Lock()
_STOP = threading.Event()
_PRINT_LOCK = threading.Lock()
_IS_WINDOWS = os.name == "nt"


def _seconds(line: str) -> float | None:
    match = OUT_US.search(line)
    if match:
        return int(match.group(1)) / 1_000_000
    match = OUT_HMS.search(line)
    if match:
        return int(match.group(1)) * 3600 + int(match.group(2)) * 60 + float(match.group(3))
    return None


def _kill_stage(proc: subprocess.Popen) -> None:
    if proc.poll() is not None:
        return
    try:
        if _IS_WINDOWS:
            subprocess.run(
                ["taskkill", "/F", "/T", "/PID", str(proc.pid)],
                capture_output=True,
                timeout=2,
            )
            # A non-zero taskkill return (notably Access denied) does not raise.
            # The stage is FFmpeg itself, so killing/reaping its root is enough.
            if proc.poll() is None:
                proc.kill()
                proc.wait(timeout=2)
        else:
            proc.terminate()
            try:
                proc.wait(timeout=2)
            except subprocess.TimeoutExpired:
                proc.kill()
    except Exception:
        try:
            proc.kill()
            proc.wait(timeout=2)
        except Exception:
            pass


def _kill_all_active() -> None:
    with _ACTIVE_LOCK:
        active = list(_ACTIVE)
    for proc in active:
        _kill_stage(proc)


def _cache_metadata_path(path: str) -> str:
    return f"{path}.json"


def _restore_cached_chunk(cache_path: str, output: str) -> bool:
    try:
        with open(_cache_metadata_path(cache_path), encoding="utf-8") as handle:
            metadata = json.load(handle)
        size = os.path.getsize(cache_path)
        if size <= 0 or int(metadata.get("size", -1)) != size:
            return False
        os.makedirs(os.path.dirname(output), exist_ok=True)
        try:
            os.remove(output)
        except FileNotFoundError:
            pass
        try:
            os.link(cache_path, output)
        except OSError:
            shutil.copy2(cache_path, output)
        try:
            os.utime(cache_path, None)
            os.utime(_cache_metadata_path(cache_path), None)
        except OSError:
            pass
        return True
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return False


def _publish_cached_chunk(output: str, cache_path: str) -> None:
    try:
        size = os.path.getsize(output)
        if size <= 0:
            return
        os.makedirs(os.path.dirname(cache_path), exist_ok=True)
        token = f"{os.getpid()}-{threading.get_ident()}"
        temp_cache = f"{cache_path}.{token}.tmp"
        temp_meta = f"{_cache_metadata_path(cache_path)}.{token}.tmp"
        try:
            try:
                os.link(output, temp_cache)
            except OSError:
                # Cache and job folders share work_dir, so a hardlink normally
                # costs no extra bytes. On filesystems without hardlinks, skip
                # publishing instead of making an unreserved multi-GB copy.
                return
            os.replace(temp_cache, cache_path)
            with open(temp_meta, "w", encoding="utf-8") as handle:
                json.dump({"size": size, "createdAt": time.time()}, handle)
            os.replace(temp_meta, _cache_metadata_path(cache_path))
        finally:
            for path in (temp_cache, temp_meta):
                try:
                    os.remove(path)
                except FileNotFoundError:
                    pass
    except OSError:
        # Cache is an optimization. A read-only/full cache volume must never
        # turn an otherwise successful export into a failed job.
        return


def _run_stage(
    cmd: list[str],
    duration: float,
    offset: float,
    cwd: str,
    on_progress: Callable[[float], None] | None = None,
) -> int:
    full = [cmd[0], "-progress", "pipe:1", "-nostats", *cmd[1:]]
    popen_kwargs: dict = {}
    if os.name == "nt":
        popen_kwargs["creationflags"] = getattr(
            subprocess, "CREATE_NEW_PROCESS_GROUP", 0
        )
    proc = subprocess.Popen(
        full,
        cwd=cwd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
        **popen_kwargs,
    )
    with _ACTIVE_LOCK:
        _ACTIVE.add(proc)
    assert proc.stdout is not None and proc.stderr is not None

    def forward_stderr() -> None:
        for line in proc.stderr:
            sys.stderr.write(line)
            sys.stderr.flush()

    err = threading.Thread(target=forward_stderr, daemon=True)
    err.start()
    try:
        for line in proc.stdout:
            if _STOP.is_set():
                _kill_stage(proc)
                break
            seconds = _seconds(line)
            if seconds is not None:
                bounded = min(max(seconds, 0.0), duration)
                if on_progress:
                    on_progress(bounded)
                else:
                    absolute = offset + bounded
                    with _PRINT_LOCK:
                        print(
                            f"out_time_us={round(absolute * 1_000_000)}",
                            flush=True,
                        )
        return proc.wait()
    finally:
        # Iterator/pipe errors and worker-future cancellation must not leave an
        # encoder running after this supervisor abandons the stage.
        if proc.poll() is None:
            _kill_stage(proc)
        err.join(timeout=2)
        with _ACTIVE_LOCK:
            _ACTIVE.discard(proc)


def _run_stages(manifest: dict) -> int:
    stages = manifest["stages"]
    if not stages:
        return 0
    max_parallel = max(1, min(len(stages), int(manifest.get("maxParallel", 1))))
    durations = [max(0.0, float(stage["duration"])) for stage in stages]
    total_duration = max(
        1e-9,
        float(manifest.get("totalDuration") or sum(durations)),
    )
    progress = [0.0] * len(stages)
    progress_lock = threading.Lock()
    last_reported = 0.0

    def update(index: int, seconds: float) -> None:
        nonlocal last_reported
        with progress_lock:
            progress[index] = max(progress[index], min(seconds, durations[index]))
            aggregate = min(total_duration, sum(progress))
            if aggregate <= last_reported:
                return
            last_reported = aggregate
            with _PRINT_LOCK:
                print(
                    f"out_time_us={round(aggregate * 1_000_000)}",
                    flush=True,
                )

    def run(index: int) -> int:
        stage = stages[index]
        cache_path = str(stage.get("cachePath") or "")
        output = str(stage.get("output") or "")
        if cache_path and output and _restore_cached_chunk(cache_path, output):
            update(index, durations[index])
            return 0
        code = _run_stage(
            stage["cmd"],
            durations[index],
            float(stage["offset"]),
            stage["cwd"],
            lambda seconds: update(index, seconds),
        )
        if code == 0:
            if cache_path and output:
                _publish_cached_chunk(output, cache_path)
            update(index, durations[index])
        return code

    _STOP.clear()
    with ThreadPoolExecutor(max_workers=max_parallel) as executor:
        next_index = 0
        futures = set()
        while next_index < min(max_parallel, len(stages)):
            futures.add(executor.submit(run, next_index))
            next_index += 1
        while futures:
            future = next(as_completed(futures))
            futures.remove(future)
            try:
                code = future.result()
            except Exception:
                code = 1
            if code:
                _STOP.set()
                _kill_all_active()
                for pending in futures:
                    pending.cancel()
                return code
            if next_index < len(stages):
                futures.add(executor.submit(run, next_index))
                next_index += 1
    return 0


def _run_tracked(cmd: list[str]) -> int:
    """Run an uninstrumented final stage while still reaping it on shutdown.

    subprocess.call would leave its ffmpeg child running when this supervisor is
    signalled mid-concat (POSIX does not propagate the signal to the child), so
    the concat is tracked in _ACTIVE like every other stage and killed on stop.
    """
    popen_kwargs: dict = {}
    if os.name == "nt":
        popen_kwargs["creationflags"] = getattr(
            subprocess, "CREATE_NEW_PROCESS_GROUP", 0
        )
    proc = subprocess.Popen(cmd, **popen_kwargs)
    with _ACTIVE_LOCK:
        _ACTIVE.add(proc)
    try:
        while True:
            if _STOP.is_set():
                _kill_stage(proc)
                return 130
            try:
                return proc.wait(timeout=0.2)
            except subprocess.TimeoutExpired:
                continue
    finally:
        if proc.poll() is None:
            _kill_stage(proc)
        with _ACTIVE_LOCK:
            _ACTIVE.discard(proc)


def _handle_stop(_signum, _frame) -> None:
    _STOP.set()
    _kill_all_active()
    raise SystemExit(130)


def main() -> int:
    for signum in (signal.SIGINT, signal.SIGTERM):
        signal.signal(signum, _handle_stop)
    with open(sys.argv[1], encoding="utf-8") as f:
        manifest = json.load(f)
    code = _run_stages(manifest)
    if code:
        return code
    # Concat is stream-copy and normally sub-second; keep UI at 99% until it is
    # atomically published by the parent job runner.
    return _run_tracked(manifest["concat"])


if __name__ == "__main__":
    raise SystemExit(main())
