"""Thin wrappers around the system ffmpeg / ffprobe binaries."""
from __future__ import annotations

import array
import base64
import json
import shutil
import subprocess
import tempfile
from pathlib import Path


def ffmpeg_available() -> bool:
    return shutil.which("ffmpeg") is not None and shutil.which("ffprobe") is not None


def _run(cmd: list[str]) -> bytes:
    proc = subprocess.run(cmd, capture_output=True)
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.decode("utf-8", "ignore")[:2000])
    return proc.stdout


def probe(path: str) -> dict:
    """Return basic media metadata via ffprobe."""
    out = _run([
        "ffprobe", "-v", "quiet", "-print_format", "json",
        "-show_format", "-show_streams", path,
    ])
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

    return {
        "durationSec": duration,
        "width": int(video["width"]) if video and video.get("width") else None,
        "height": int(video["height"]) if video and video.get("height") else None,
        "fps": fps,
        "hasVideo": video is not None,
        "hasAudio": audio is not None,
        # Used to decide whether the full-GPU export path can decode this.
        "videoCodec": video.get("codec_name") if video else None,
        "pixFmt": video.get("pix_fmt") if video else None,
    }


def thumbnail_strip(path: str, count: int, width: int = 160) -> list[str]:
    """Capture `count` frames evenly across the video, return JPEG data URLs."""
    meta = probe(path)
    duration = meta["durationSec"] or 1.0
    frames: list[str] = []
    with tempfile.TemporaryDirectory() as tmp:
        for i in range(count):
            t = max(0.0, min((i / count) * duration, duration - 0.05))
            out = str(Path(tmp) / f"f{i}.jpg")
            # -ss before -i = fast keyframe seek; scale keeps aspect (height auto).
            _run([
                "ffmpeg", "-v", "quiet", "-ss", f"{t:.3f}", "-i", path,
                "-frames:v", "1", "-vf", f"scale={width}:-1",
                "-q:v", "5", "-y", out,
            ])
            raw = Path(out).read_bytes()
            frames.append("data:image/jpeg;base64," + base64.b64encode(raw).decode("ascii"))
    return frames


def waveform_peaks(path: str, max_peaks: int = 4000, sample_rate: int = 4000) -> list[float]:
    """Decode audio to mono PCM and reduce to normalised 0..1 peak buckets."""
    meta = probe(path)
    if not meta["hasAudio"]:
        return []

    # Decode to raw signed 16-bit mono PCM on stdout.
    pcm = _run([
        "ffmpeg", "-v", "quiet", "-i", path,
        "-ac", "1", "-ar", str(sample_rate), "-f", "s16le", "-",
    ])
    samples = array.array("h")
    samples.frombytes(pcm)
    n = len(samples)
    if n == 0:
        return []

    duration = meta["durationSec"] or (n / sample_rate)
    num_peaks = max(1, min(max_peaks, int(duration * 20) or 1))
    bucket = max(1, n // num_peaks)

    peaks: list[float] = []
    for start in range(0, n, bucket):
        chunk = samples[start:start + bucket]
        if not chunk:
            continue
        # max abs amplitude in the bucket, normalised to 0..1
        hi = max(chunk)
        lo = min(chunk)
        amp = max(hi, -lo)
        peaks.append(round(amp / 32768.0, 4))
    return peaks
