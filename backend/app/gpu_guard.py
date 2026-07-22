"""VRAM admission control — keep the machine usable when OTHER processes are
already eating the GPU.

The backend's `HEAVY_JOB_SEMAPHORE` only serialises *our own* heavy jobs. It does
nothing about a game, another ML app, or a second copy of this tool on the same
card. Loading a CUDA model (WhisperX, OmniVoice, Demucs) into a card that's
already nearly full is the worst case described all over the project memory:
CUDA spills to shared system RAM over PCIe and the job crawls at ~5% speed with
the GPU pinned at 100% — freezing the whole machine for 10-30 minutes.

This module is the gate that prevents that. Before a heavy GPU load, callers
`wait_for_vram(need_mb)`:
  * No CUDA / torch not loaded → returns True immediately (CPU path, nothing to gate).
  * Enough free VRAM (device-wide, counts every process) → returns True at once.
  * Not enough → polls until it frees up, the caller cancels, or a timeout hits.

On timeout the caller decides how to degrade: WhisperX/Demucs drop to CPU (slow
but the machine stays responsive), TTS surfaces a clear "GPU busy" error instead
of thrashing. Either is vastly better UX than a 20-minute freeze.

Everything is best-effort and advisory: a probe failure fails OPEN (returns True)
so this can never wedge a job on its own.
"""
from __future__ import annotations

import logging
import subprocess
import sys
import threading
import time

from .config import get_settings

log = logging.getLogger(__name__)

# Rough resident footprints (MB) used as the default `need` per workload. These
# are the steady-state load sizes measured in the project notes, not peak — the
# floor below adds headroom on top.
NEED_WHISPER_SMALL = 1200
NEED_WHISPER_LARGE = 4200
NEED_OMNIVOICE = 2400
NEED_DEMUCS = 2400
# FunASR loads paraformer-large + fsmn-vad + ct-punc (~1.5-2GB weights) and its
# inference batches add sizeable activation peaks. Gating it at the WhisperX-
# small footprint let it load into a card with ~1.3GB free and die mid-inference
# with a NATIVE crash that took the whole backend down (2026-07-10). Sized so a
# nearly-full 8GB card degrades to CPU instead.
NEED_FUNASR = 3000

# A waiter registry so /metrics can show what's currently blocked on VRAM.
_lock = threading.Lock()
_waiters: dict[str, dict] = {}


def _enabled() -> bool:
    return bool(getattr(get_settings(), "gpu_guard_enabled", True))


def cuda_free_mb() -> int | None:
    """Device-wide free VRAM in MB across ALL processes, or None when there's no
    CUDA to gate (torch absent/not yet imported, or no GPU). We deliberately do
    NOT import torch here — that 10-30s cold import belongs to the warm-up thread,
    not a gate on the request path. If torch isn't loaded yet, there's no resident
    model of ours either, so failing open is correct."""
    torch = sys.modules.get("torch")
    if torch is None:
        return _nvidia_smi_free_mb()
    try:
        if not torch.cuda.is_available():
            return None
        free, _total = torch.cuda.mem_get_info()
        return int(free / 1024 / 1024)
    except Exception:  # noqa: BLE001
        return _nvidia_smi_free_mb()


def _nvidia_smi_free_mb() -> int | None:
    """Lightweight device-wide VRAM probe when torch is not loaded in this process.

    TTS runs in a separate OmniVoice interpreter, so the FastAPI process may not
    have imported torch even though the subprocess is about to use CUDA. In that
    case failing open lets the worker load into an already-full card and crawl
    through shared memory. `nvidia-smi` is cheap and avoids importing torch on the
    request path.
    """
    try:
        r = subprocess.run(
            [
                "nvidia-smi",
                "--query-gpu=memory.free",
                "--format=csv,noheader,nounits",
            ],
            capture_output=True,
            text=True,
            timeout=3,
        )
    except Exception:  # noqa: BLE001
        return None
    if r.returncode != 0:
        return None
    values: list[int] = []
    for line in r.stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            values.append(int(line.split()[0]))
        except (ValueError, IndexError):
            continue
    return min(values) if values else None


def wait_for_vram(
    need_mb: int,
    *,
    kind: str,
    timeout: float | None = None,
    poll: float | None = None,
    cancel=None,
    on_wait=None,
) -> bool:
    """Block until at least `need_mb` (+ configured headroom) of VRAM is free.

    Returns True when there's room (or there's no CUDA to gate). Returns False if
    the wait times out or `cancel()` becomes true — the caller then degrades to
    CPU or surfaces a clear error rather than loading into a full card.

    `kind` labels the waiter for /metrics. `on_wait(free, need)` fires once when a
    wait actually begins (for logging / progress messages).
    """
    if not _enabled():
        return True
    s = get_settings()
    floor = int(getattr(s, "gpu_min_free_mb", 1200))
    need = max(int(need_mb), floor)
    timeout = float(getattr(s, "gpu_wait_timeout_sec", 60)) if timeout is None else timeout
    poll = float(getattr(s, "gpu_wait_poll_sec", 1.0)) if poll is None else poll

    free = cuda_free_mb()
    if free is None:
        return True  # CPU path — nothing to gate
    if free >= need:
        return True

    deadline = time.time() + max(0.0, timeout)
    announced = False
    try:
        with _lock:
            _waiters[kind] = {"since": time.time(), "freeMB": free, "needMB": need}
        while True:
            free = cuda_free_mb()
            if free is None or free >= need:
                return True
            if cancel and cancel():
                return False
            if time.time() >= deadline:
                log.warning(
                    "VRAM gate timed out for %s: free=%dMB < need=%dMB after %.0fs",
                    kind, free, need, timeout,
                )
                return False
            if not announced:
                announced = True
                log.info("Waiting for VRAM (%s): free=%dMB < need=%dMB", kind, free, need)
                if on_wait:
                    try:
                        on_wait(free, need)
                    except Exception:  # noqa: BLE001
                        pass
            time.sleep(max(0.1, poll))
    finally:
        with _lock:
            _waiters.pop(kind, None)


def snapshot() -> dict:
    """Current gate state for /metrics: free VRAM + anything blocked waiting."""
    now = time.time()
    with _lock:
        waiters = [
            {
                "kind": k,
                "waitingSec": round(now - v["since"], 1),
                "freeMB": v["freeMB"],
                "needMB": v["needMB"],
            }
            for k, v in _waiters.items()
        ]
    return {
        "enabled": _enabled(),
        "freeMB": cuda_free_mb(),
        "minFreeMB": int(getattr(get_settings(), "gpu_min_free_mb", 1200)),
        "waiting": waiters,
    }
