"""Thin wrappers around the system ffmpeg / ffprobe binaries."""
from __future__ import annotations

import array
import base64
import json
import os
import queue
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Callable

CancelCheck = Callable[[], bool]


def ffmpeg_available() -> bool:
    return shutil.which("ffmpeg") is not None and shutil.which("ffprobe") is not None


def ffmpeg_runtime_info() -> dict:
    """Return the exact FFmpeg executable/version backing this backend."""
    executable = shutil.which("ffmpeg")
    probe_executable = shutil.which("ffprobe")
    info = {
        "available": bool(executable and probe_executable),
        "path": os.path.abspath(executable) if executable else None,
        "probePath": os.path.abspath(probe_executable) if probe_executable else None,
        "version": None,
    }
    if not info["available"]:
        return info
    try:
        result = subprocess.run(
            [str(executable), "-hide_banner", "-version"],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
        lines = (result.stdout or result.stderr).splitlines()
        if result.returncode == 0 and lines:
            info["version"] = lines[0].strip()[:300]
    except (OSError, subprocess.SubprocessError):
        pass
    return info


class FfmpegCancelled(Exception):
    """Client disconnected / cancel_check fired mid-ffmpeg."""


def _kill_proc(proc: subprocess.Popen) -> None:
    try:
        from app.process_runner import kill_process_tree
        kill_process_tree(proc)
    except Exception:  # noqa: BLE001
        try:
            proc.kill()
        except Exception:  # noqa: BLE001
            pass
        try:
            proc.wait(timeout=5)
        except Exception:  # noqa: BLE001
            pass


def _run(
    cmd: list[str], *, cancel_check: CancelCheck | None = None,
    timeout_sec: float | None = None,
) -> bytes:
    """Run a command; when cancel_check is set, poll and tree-kill on cancel."""
    if cancel_check is None:
        proc = subprocess.run(cmd, capture_output=True, timeout=timeout_sec)
        if proc.returncode != 0:
            raise RuntimeError(proc.stderr.decode("utf-8", "ignore")[:2000])
        return proc.stdout

    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    assert proc.stdout is not None and proc.stderr is not None
    out_chunks: list[bytes] = []
    err_chunks: list[bytes] = []

    def _drain(stream, sink: list[bytes]) -> None:
        try:
            while True:
                chunk = stream.read(65536)
                if not chunk:
                    break
                sink.append(chunk)
        except Exception:  # noqa: BLE001
            pass

    t_out = threading.Thread(target=_drain, args=(proc.stdout, out_chunks), daemon=True)
    t_err = threading.Thread(target=_drain, args=(proc.stderr, err_chunks), daemon=True)
    t_out.start()
    t_err.start()
    try:
        while proc.poll() is None:
            if cancel_check():
                _kill_proc(proc)
                raise FfmpegCancelled("cancelled")
            try:
                proc.wait(timeout=0.25)
            except subprocess.TimeoutExpired:
                continue
        t_out.join(timeout=2)
        t_err.join(timeout=2)
        if cancel_check():
            raise FfmpegCancelled("cancelled")
        if proc.returncode != 0:
            err = b"".join(err_chunks).decode("utf-8", "ignore")[:2000]
            raise RuntimeError(err or f"ffmpeg exited {proc.returncode}")
        return b"".join(out_chunks)
    finally:
        if proc.poll() is None:
            _kill_proc(proc)


_STDERR_TAIL_BYTES = 4096


def _run_streaming(
    cmd: list[str],
    on_stdout: Callable[[bytes], None],
    *,
    cancel_check: CancelCheck | None = None,
    chunk_size: int = 65536,
    timeout_sec: float | None = None,
) -> None:
    """Run `cmd`, feeding stdout to `on_stdout` chunk by chunk.

    Unlike :func:`_run` this never materialises the full stdout. Used for raw PCM
    (a 10 h track is ~288 MB at 4 kHz s16 mono, and joining + copying it into an
    array doubled that). stderr is drained on a thread and kept to a bounded tail
    so a chatty ffmpeg can't grow RAM either.
    """
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    assert proc.stdout is not None and proc.stderr is not None
    err_tail = bytearray()
    stdout_queue: queue.Queue[bytes] = queue.Queue(maxsize=8)
    stdout_done = threading.Event()
    reader_stop = threading.Event()

    def _drain_err() -> None:
        try:
            while True:
                chunk = proc.stderr.read(4096)  # type: ignore[union-attr]
                if not chunk:
                    break
                err_tail.extend(chunk)
                if len(err_tail) > _STDERR_TAIL_BYTES:
                    del err_tail[: len(err_tail) - _STDERR_TAIL_BYTES]
        except Exception:  # noqa: BLE001
            pass

    def _drain_stdout() -> None:
        """Read the blocking Windows pipe away from the cancellation loop.

        A bounded queue keeps memory flat when the reducer is slower than
        FFmpeg.  ``reader_stop`` also prevents this daemon from remaining
        blocked on ``put`` after cancellation while the process tree is being
        torn down.
        """
        try:
            while not reader_stop.is_set():
                chunk = proc.stdout.read(chunk_size)  # type: ignore[union-attr]
                if not chunk:
                    break
                while not reader_stop.is_set():
                    try:
                        stdout_queue.put(chunk, timeout=0.1)
                        break
                    except queue.Full:
                        continue
        except Exception:  # noqa: BLE001 - process kill closes the pipe
            pass
        finally:
            stdout_done.set()

    t_err = threading.Thread(target=_drain_err, daemon=True)
    t_out = threading.Thread(target=_drain_stdout, daemon=True)
    t_err.start()
    t_out.start()
    started = time.monotonic()
    try:
        while True:
            if cancel_check and cancel_check():
                _kill_proc(proc)
                raise FfmpegCancelled("cancelled")
            if timeout_sec is not None and timeout_sec > 0:
                if time.monotonic() - started >= timeout_sec:
                    _kill_proc(proc)
                    raise RuntimeError(
                        f"ffmpeg timed out after {timeout_sec:.0f}s"
                    )
            try:
                chunk = stdout_queue.get(timeout=0.1)
            except queue.Empty:
                chunk = None
            if chunk is not None:
                on_stdout(chunk)
            if stdout_done.is_set() and stdout_queue.empty():
                if proc.poll() is not None:
                    break
        proc.wait(timeout=5)
        t_out.join(timeout=2)
        t_err.join(timeout=2)
        if cancel_check and cancel_check():
            raise FfmpegCancelled("cancelled")
        if proc.returncode != 0:
            err = bytes(err_tail).decode("utf-8", "ignore")
            raise RuntimeError(err or f"ffmpeg exited {proc.returncode}")
    finally:
        reader_stop.set()
        if proc.poll() is None:
            _kill_proc(proc)
        t_out.join(timeout=2)


def probe(path: str) -> dict:
    """Return basic media metadata via ffprobe."""
    out = _run([
        "ffprobe", "-v", "quiet", "-print_format", "json",
        "-show_format", "-show_streams", path,
    ], timeout_sec=30)
    data = json.loads(out)
    streams = data.get("streams", [])
    fmt = data.get("format", {})

    video = next((s for s in streams if s.get("codec_type") == "video"), None)
    audio = next((s for s in streams if s.get("codec_type") == "audio"), None)

    duration = float(fmt.get("duration") or (video or audio or {}).get("duration") or 0)

    fps = 0.0
    if video and video.get("avg_frame_rate") and video["avg_frame_rate"] != "0/0":
        num, _, den = video["avg_frame_rate"].partition("/")
        try:
            fps = float(num) / float(den) if float(den) else 0.0
        except (ValueError, ZeroDivisionError):
            fps = 0.0

    rotation = 0.0
    if video:
        raw_rotation = (video.get("tags") or {}).get("rotate")
        if raw_rotation is None:
            for side_data in video.get("side_data_list") or []:
                if side_data.get("rotation") is not None:
                    raw_rotation = side_data.get("rotation")
                    break
        try:
            rotation = float(raw_rotation or 0)
        except (TypeError, ValueError):
            rotation = 0.0

    mastering_display = None
    content_light_level = None
    if video and video.get("color_transfer") in {"smpte2084", "arib-std-b67"}:
        side_data = list(video.get("side_data_list") or [])
        # HDR SEI commonly appears only on decoded frames, not in the stream
        # object returned by -show_streams. Read exactly one frame so this stays
        # bounded even for multi-hour sources.
        if not any(
            item.get("side_data_type") in {
                "Mastering display metadata", "Content light level metadata"
            }
            for item in side_data
        ):
            try:
                frame_raw = _run([
                    "ffprobe", "-v", "quiet", "-print_format", "json",
                    "-select_streams", "v:0", "-show_frames",
                    "-read_intervals", "%+#1", path,
                ], timeout_sec=15)
                frames = json.loads(frame_raw).get("frames") or []
                if frames:
                    side_data.extend(frames[0].get("side_data_list") or [])
            except Exception:
                # Static HDR metadata is optional. Basic colour signalling still
                # allows a truthful HDR10 contract when SEI is absent/unreadable.
                pass
        mastering_display = next((
            item for item in side_data
            if item.get("side_data_type") == "Mastering display metadata"
        ), None)
        content_light_level = next((
            item for item in side_data
            if item.get("side_data_type") == "Content light level metadata"
        ), None)

    return {
        "durationSec": duration,
        "width": int(video["width"]) if video and video.get("width") else None,
        "height": int(video["height"]) if video and video.get("height") else None,
        "fps": fps,
        "hasVideo": video is not None,
        "hasAudio": audio is not None,
        # Used to decide whether the full-GPU export path can decode this.
        "videoCodec": video.get("codec_name") if video else None,
        "audioCodec": audio.get("codec_name") if audio else None,
        "audioChannels": int(audio.get("channels") or 0) if audio else 0,
        "audioSampleRate": int(audio.get("sample_rate") or 0) if audio else 0,
        "pixFmt": video.get("pix_fmt") if video else None,
        "colorPrimaries": video.get("color_primaries") if video else None,
        "colorTransfer": video.get("color_transfer") if video else None,
        "colorSpace": video.get("color_space") if video else None,
        "colorRange": video.get("color_range") if video else None,
        "masteringDisplay": mastering_display,
        "contentLightLevel": content_light_level,
        "sampleAspectRatio": video.get("sample_aspect_ratio") if video else None,
        "rotation": rotation,
    }


def probe_duration(path: str) -> float:
    """Media length in seconds via ffprobe, or 0.0 if it can't be resolved."""
    try:
        return float(probe(path).get("durationSec") or 0.0)
    except Exception:  # noqa: BLE001 — a probe failure shouldn't sink the caller
        return 0.0


"""Concurrent ffmpeg processes used to grab thumbnails. Bounded so a strip on a
long video can't starve preview/export of CPU."""
_THUMB_MAX_WORKERS = 4


def thumbnail_strip(
    path: str,
    count: int,
    width: int = 160,
    *,
    cancel_check: CancelCheck | None = None,
) -> list[str]:
    """Capture `count` frames evenly across the video, return JPEG data URLs.

    One ffmpeg per frame, but at most ``_THUMB_MAX_WORKERS`` at a time and each
    with ``-ss`` BEFORE ``-i`` so it keyframe-seeks straight to the timestamp.

    Two shapes were rejected: a process per frame with no bound (~60 spawns
    dominated media-panel latency), and a single invocation using an ``fps``
    filter — that reads sequentially and so decodes almost the whole file, which
    on multi-hour 4K footage is far slower than N bounded fast-seeks.
    """
    if count <= 0:
        return []
    if cancel_check and cancel_check():
        raise FfmpegCancelled("cancelled")
    meta = probe(path)
    duration = float(meta["durationSec"] or 1.0)
    timestamps = [
        max(0.0, min((i / count) * duration, duration - 0.05)) for i in range(count)
    ]

    frames: list[str] = []
    with tempfile.TemporaryDirectory() as tmp:

        def _grab(index: int, when: float) -> tuple[int, Path]:
            if cancel_check and cancel_check():
                raise FfmpegCancelled("cancelled")
            out = Path(tmp) / f"f{index}.jpg"
            # -ss before -i = input (fast keyframe) seek: no decode from frame 0.
            _run(
                [
                    "ffmpeg", "-v", "quiet", "-ss", f"{when:.3f}", "-i", path,
                    "-frames:v", "1", "-vf", f"scale={width}:-1",
                    "-q:v", "5", "-y", str(out),
                ],
                cancel_check=cancel_check,
            )
            return index, out

        workers = max(1, min(_THUMB_MAX_WORKERS, count))
        produced: dict[int, Path] = {}
        with ThreadPoolExecutor(max_workers=workers) as pool:
            futures = [pool.submit(_grab, i, t) for i, t in enumerate(timestamps)]
            try:
                for fut in futures:
                    index, out = fut.result()
                    produced[index] = out
            except BaseException:
                # Cancel / error: stop the queue; running ffmpeg children are
                # tree-killed by their own _run cancel loop.
                for fut in futures:
                    fut.cancel()
                raise

        for i in range(count):
            out = produced.get(i)
            if out is None or not out.is_file():
                # Short/corrupt media can yield fewer frames; stop rather than
                # inventing blanks (callers treat length as best-effort).
                break
            raw = out.read_bytes()
            frames.append(
                "data:image/jpeg;base64," + base64.b64encode(raw).decode("ascii")
            )
    return frames


def waveform_peaks(
    path: str,
    max_peaks: int = 4000,
    sample_rate: int = 4000,
    *,
    cancel_check: CancelCheck | None = None,
) -> list[float]:
    """Decode audio to mono PCM and reduce to normalised 0..1 peak buckets.

    Streams the PCM: only one bucket (plus one read chunk) is ever resident, so
    RAM is flat in the source duration. Previously the whole raw stream was
    joined, copied into an ``array`` and then sliced per bucket — ~2x the PCM
    size live at once, which for multi-hour media pushed the backend to OOM.
    """
    meta = probe(path)
    if not meta["hasAudio"]:
        return []

    duration = meta["durationSec"] or 0.0
    num_peaks = max(1, min(max_peaks, int(duration * 20) or 1))
    expected_samples = int(duration * sample_rate)
    # Without a duration we can't size buckets up front; fall back to 1 s buckets.
    bucket = max(1, expected_samples // num_peaks) if expected_samples > 0 else sample_rate

    peaks: list[float] = []
    pending = array.array("h")
    carry = bytearray()  # odd trailing byte of a split s16 sample

    def _drain_buckets(final: bool = False) -> None:
        while len(peaks) < num_peaks and (len(pending) >= bucket or (final and pending)):
            take = min(bucket, len(pending))
            window = pending[:take]
            amp = max(max(window), -min(window))
            peaks.append(round(amp / 32768.0, 4))
            del pending[:take]

    def _on_chunk(chunk: bytes) -> None:
        if len(peaks) >= num_peaks:
            return  # enough resolution; keep draining ffmpeg but stop accumulating
        carry.extend(chunk)
        usable = len(carry) - (len(carry) % 2)
        if usable:
            block = array.array("h")
            block.frombytes(bytes(carry[:usable]))
            if sys.byteorder == "big":
                block.byteswap()  # ffmpeg emits little-endian s16le
            pending.extend(block)
            del carry[:usable]
        _drain_buckets()

    _run_streaming(
        [
            "ffmpeg", "-v", "quiet", "-i", path,
            "-ac", "1", "-ar", str(sample_rate), "-f", "s16le", "-",
        ],
        _on_chunk,
        cancel_check=cancel_check,
        timeout_sec=max(120.0, min(6 * 3600.0, 120.0 + duration * 1.5)),
    )
    _drain_buckets(final=True)
    return peaks
