"""Cancellable one-shot FunASR subprocess orchestration.

The model stays outside uvicorn so native CUDA failures cannot take down the
backend. Every attempt is tree-killed on owner cancellation or timeout.
"""
from __future__ import annotations

import json
import logging
import os
import sys
import threading
import uuid
from typing import Callable

from .base import ASRSegment

log = logging.getLogger(__name__)
_WORKER_MODULE = "funasr_worker_entry"
CancelCheck = Callable[[], bool]


class FunAsrCancelled(Exception):
    """The request/job owner cancelled the one-shot worker."""


def _busy_lock() -> threading.Lock:
    from ..routers.transcribe import _busy

    return _busy


def release() -> None:
    """Nothing is resident in this process; kept for the shared ASR API."""
    return None


def _read_result(path: str) -> dict | None:
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:  # noqa: BLE001
        return None


def _segments_from_result(result: dict) -> list[ASRSegment]:
    segments: list[ASRSegment] = []
    for raw in result.get("segments") or []:
        try:
            segments.append(
                ASRSegment(
                    start=float(raw.get("start", 0.0)),
                    end=float(raw.get("end", 0.0)),
                    text=str(raw.get("text") or ""),
                    speaker_id=(
                        str(raw["speaker_id"])
                        if raw.get("speaker_id") is not None
                        else None
                    ),
                    words=list(raw.get("words") or []),
                    confidence=raw.get("confidence"),
                )
            )
        except (TypeError, ValueError):
            continue
    return segments


def _attempt(
    audio_path: str,
    language: str | None,
    device_mode: str,
    out_path: str,
    *,
    cancel_check: CancelCheck | None = None,
    timeout_sec: float,
) -> str | None:
    """Run one isolated worker; return an error string or raise on cancel."""
    from ..config import BACKEND_ROOT
    from ..process_runner import ProcessOutcome, run_process

    cmd = [
        sys.executable,
        "-m",
        _WORKER_MODULE,
        audio_path,
        language or "-",
        device_mode,
        out_path,
    ]
    result = run_process(
        cmd,
        cwd=BACKEND_ROOT,
        timeout=timeout_sec,
        cancel_check=cancel_check,
        max_log_bytes=8192,
        raise_on_error=False,
    )
    if result.outcome == ProcessOutcome.CANCELLED:
        raise FunAsrCancelled("FunASR worker cancelled")
    if result.outcome == ProcessOutcome.TIMED_OUT:
        return f"timed out after {timeout_sec:.0f}s (worker tree killed)"

    payload = _read_result(out_path)
    if result.returncode == 0 and payload and payload.get("status") == "done":
        log.info(
            "FunASR worker done (device_mode=%s) in %.1fs",
            device_mode,
            result.duration_sec,
        )
        return None
    if payload and payload.get("status") == "error" and payload.get("error"):
        return str(payload["error"])[:800]
    tail = (result.stderr or "").strip()[-800:]
    return f"worker exited {result.returncode}" + (
        f": {tail}" if tail else " (no result file; possible native crash)"
    )


def transcribe(
    audio_path: str,
    language: str | None = None,
    *,
    cancel_check: CancelCheck | None = None,
    timeout_sec: float = 1800,
) -> list[ASRSegment]:
    """Transcribe with cancellable GPU admission, worker execution and fallback."""
    from .. import gpu_guard
    from ..config import get_settings
    from ..export.job import safe_rmtree_jobdir
    from ..resource_coordinator import (
        AcquireCancelledError,
        ResourceKind,
        resource_guard,
    )

    def cancelled() -> bool:
        return bool(cancel_check and cancel_check())

    busy = _busy_lock()
    try:
        with resource_guard(
            ResourceKind.GPU_MODEL,
            cancel_check=cancel_check,
            owner="funasr-transcribe",
        ):
            while not busy.acquire(timeout=0.25):
                if cancelled():
                    raise FunAsrCancelled("cancelled while waiting for ASR")
            try:
                if cancelled():
                    raise FunAsrCancelled("cancelled before worker start")
                device_mode = "auto"
                if not gpu_guard.wait_for_vram(
                    gpu_guard.NEED_FUNASR,
                    kind="funasr",
                    cancel=cancel_check,
                ):
                    if cancelled():
                        raise FunAsrCancelled("cancelled while waiting for VRAM")
                    log.warning("Insufficient free VRAM for FunASR; using CPU.")
                    device_mode = "cpu"

                work = os.path.abspath(
                    os.path.join(
                        get_settings().work_dir,
                        "asr",
                        "funasr_" + uuid.uuid4().hex[:10],
                    )
                )
                os.makedirs(work, exist_ok=True)
                out_path = os.path.join(work, "result.json")
                try:
                    err = _attempt(
                        audio_path,
                        language,
                        device_mode,
                        out_path,
                        cancel_check=cancel_check,
                        timeout_sec=timeout_sec,
                    )
                    if err is None:
                        return _segments_from_result(_read_result(out_path) or {})
                    if device_mode == "cpu":
                        raise RuntimeError(f"FunASR failed: {err}")
                    if cancelled():
                        raise FunAsrCancelled("cancelled before CPU fallback")

                    log.warning(
                        "FunASR GPU attempt failed (%s); retrying once on CPU.",
                        err,
                    )
                    try:
                        os.remove(out_path)
                    except OSError:
                        pass
                    err_cpu = _attempt(
                        audio_path,
                        language,
                        "cpu",
                        out_path,
                        cancel_check=cancel_check,
                        timeout_sec=timeout_sec,
                    )
                    if err_cpu is None:
                        return _segments_from_result(_read_result(out_path) or {})
                    raise RuntimeError(
                        f"FunASR failed (GPU: {err}; CPU retry: {err_cpu})"
                    )
                finally:
                    safe_rmtree_jobdir(work)
            finally:
                busy.release()
    except AcquireCancelledError as e:
        raise FunAsrCancelled("cancelled while waiting for GPU coordinator") from e
