from __future__ import annotations

import re
from pathlib import Path


SETUP = Path(__file__).resolve().parents[1] / "setup.ps1"


def test_packaged_ffmpeg_is_versioned_and_checksum_verified():
    script = SETUP.read_text(encoding="utf-8")

    version = re.search(r'\$ffmpegVersion\s*=\s*"([^"\r\n]+)"', script)
    checksum = re.search(r'\$ffmpegSha256\s*=\s*"([0-9a-f]{64})"', script)
    url = re.search(r'\$ffmpegUrl\s*=\s*"([^"\r\n]+)"', script)

    assert version, "Packaged FFmpeg must have an explicit version"
    assert checksum, "Packaged FFmpeg must have a pinned SHA-256"
    assert url and version.group(1) in url.group(1)
    assert "ffmpeg-release-essentials.zip" not in url.group(1)
    assert "Get-FileHash -Algorithm SHA256" in script
    assert "FFmpeg checksum mismatch" in script
    assert 'Test-Path (Join-Path $BinDir "ffprobe.exe")' in script
    assert "Remove-Item -LiteralPath $zip, $temp" in script
    assert "Invoke-WebRequest -Uri $ffmpegUrl -OutFile $zip -TimeoutSec 180" in script
    assert "FFmpeg archive does not contain ffmpeg.exe" in script
    assert "FFmpeg archive does not contain ffprobe.exe" in script
