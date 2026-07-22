"""Compare Browser and Server exports at deterministic frame timestamps.

Usage:
  python backend/scripts/compare_export_parity.py browser.mp4 server.mp4 \
      --times 0,1.5,5,12.25 --output .work/parity-report

The command writes extracted frames, amplified diff images and report.json. It
returns exit code 1 when any frame exceeds --max-mae, making it usable as a
release/fixture gate without pretending FFmpeg and Canvas are always identical.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import subprocess
from pathlib import Path

from PIL import Image, ImageChops, ImageEnhance, ImageStat


def normalized_mae(left: Image.Image, right: Image.Image) -> float:
    """Mean absolute RGB error normalized to 0..1."""
    a = left.convert("RGB")
    b = right.convert("RGB")
    if a.size != b.size:
        raise ValueError(f"frame dimensions differ: {a.size} vs {b.size}")
    stat = ImageStat.Stat(ImageChops.difference(a, b))
    return sum(stat.mean) / (len(stat.mean) * 255.0)


def _extract_frame(video: Path, timestamp: float, output: Path) -> None:
    cmd = [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-ss",
        f"{timestamp:.6f}",
        "-i",
        str(video),
        "-frames:v",
        "1",
        "-pix_fmt",
        "rgb24",
        str(output),
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    if result.returncode != 0 or not output.is_file():
        raise RuntimeError(
            f"cannot extract {video.name} at {timestamp:.3f}s: {result.stderr[-1000:]}"
        )


def compare_exports(
    browser_video: Path,
    server_video: Path,
    timestamps: list[float],
    output_dir: Path,
    max_mae: float,
) -> dict:
    output_dir.mkdir(parents=True, exist_ok=True)
    frames: list[dict] = []
    for index, timestamp in enumerate(timestamps):
        browser_frame = output_dir / f"{index:03d}-{timestamp:.3f}-browser.png"
        server_frame = output_dir / f"{index:03d}-{timestamp:.3f}-server.png"
        diff_frame = output_dir / f"{index:03d}-{timestamp:.3f}-diff.png"
        _extract_frame(browser_video, timestamp, browser_frame)
        _extract_frame(server_video, timestamp, server_frame)
        with Image.open(browser_frame) as left, Image.open(server_frame) as right:
            mae = normalized_mae(left, right)
            diff = ImageChops.difference(left.convert("RGB"), right.convert("RGB"))
            ImageEnhance.Contrast(diff).enhance(4).save(diff_frame)
        frames.append(
            {
                "timestampSec": timestamp,
                "normalizedMae": round(mae, 8),
                "passed": mae <= max_mae,
                "browserFrame": browser_frame.name,
                "serverFrame": server_frame.name,
                "diffFrame": diff_frame.name,
            }
        )
    report = {
        "browser": os.path.abspath(browser_video),
        "server": os.path.abspath(server_video),
        "maxMae": max_mae,
        "passed": all(frame["passed"] for frame in frames),
        "worstMae": max((frame["normalizedMae"] for frame in frames), default=0),
        "frames": frames,
    }
    with open(output_dir / "report.json", "w", encoding="utf-8") as out:
        json.dump(report, out, ensure_ascii=False, indent=2)
    return report


def _parse_times(raw: str) -> list[float]:
    values = [float(value.strip()) for value in raw.split(",") if value.strip()]
    if not values or any(not math.isfinite(value) or value < 0 for value in values):
        raise argparse.ArgumentTypeError(
            "--times must contain finite non-negative seconds"
        )
    return values


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("browser", type=Path)
    parser.add_argument("server", type=Path)
    parser.add_argument("--times", type=_parse_times, default=_parse_times("0,1,5"))
    parser.add_argument("--output", type=Path, default=Path(".work/parity-report"))
    parser.add_argument("--max-mae", type=float, default=0.01)
    args = parser.parse_args()
    if not 0 <= args.max_mae <= 1:
        parser.error("--max-mae must be between 0 and 1")
    report = compare_exports(
        args.browser.resolve(),
        args.server.resolve(),
        args.times,
        args.output.resolve(),
        args.max_mae,
    )
    print(json.dumps({"passed": report["passed"], "worstMae": report["worstMae"]}))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
