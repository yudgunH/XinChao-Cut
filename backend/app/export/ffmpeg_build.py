"""Translate an ExportSpec (timeline JSON) into a single FFmpeg command.

Native filter-graph compositing: trim/speed/scale/transform (incl. rotation)/
zoom effects/opacity/fade/colour per visual clip overlaid by track order, audio
mixed, captions burned via ASS, encoded with hardware acceleration when
available. This is fast on one machine (no per-frame canvas/screenshot
roundtrip) at the cost of some fidelity vs the canvas preview.
"""
from __future__ import annotations

import functools
import logging
import math
import os
import subprocess

from ..config import get_settings
from .ass import build_ass

_HW_ENCODERS = ["h264_nvenc", "h264_qsv", "h264_amf", "h264_videotoolbox"]

# Above this many video inputs, decode in software instead of spinning up a GPU
# (cuvid / -hwaccel) decode context per input. Each HW context reserves a chunk
# of VRAM; dozens at once exhaust it and crash the export on modest GPUs. After
# the contiguous-run merge most timelines sit at 1–3 video clips, so the GPU
# path stays the norm — this is purely a safety ceiling for pathological splits.
_MAX_HW_DECODERS = 8


def _encoder_works(enc: str) -> bool:
    """A hardware encoder can be *listed* but unusable (no GPU/driver). Run a
    tiny real encode to confirm it actually works before committing to it.

    The probe is 256x256, NOT a smaller size: NVENC has a minimum encode
    resolution (≈145px wide on current drivers), so a 64x64/128x128 test fails
    with "-22 Invalid argument" on a GPU where NVENC actually works fine for real
    (≥720p) exports — a false negative that silently demoted NVENC to QSV/CPU.
    256x256 clears every HW encoder's minimum while staying fast to encode."""
    try:
        r = subprocess.run(
            ["ffmpeg", "-hide_banner", "-f", "lavfi", "-i", "color=black:s=256x256:d=0.1",
             "-c:v", enc, "-f", "null", "-"],
            capture_output=True, text=True, timeout=20,
        )
        return r.returncode == 0
    except Exception:
        return False


@functools.lru_cache
def detect_video_encoder() -> str:
    """Return the best *working* H.264 encoder (hardware first, else libx264)."""
    try:
        out = subprocess.run(
            ["ffmpeg", "-hide_banner", "-encoders"], capture_output=True, text=True
        ).stdout
    except Exception:
        logging.getLogger(__name__).warning(
            "Video encoder: libx264 (CPU) — could not run `ffmpeg -encoders`"
        )
        return "libx264"
    for enc in _HW_ENCODERS:
        if enc in out and _encoder_works(enc):
            logging.getLogger(__name__).info("Video encoder: %s (hardware)", enc)
            return enc
    logging.getLogger(__name__).warning(
        "Video encoder: libx264 (CPU fallback — no working hardware encoder found)"
    )
    return "libx264"


def proxy_quality_args(encoder: str) -> list[str]:
    """Speed-oriented quality args per encoder (proxies are throwaway previews,
    so favour encode speed; quality just needs to be good enough to scrub).
    Hardware encoders don't accept -crf — each has its own quality knob."""
    if encoder == "h264_nvenc":
        return ["-preset", "p4", "-rc", "vbr", "-cq", "29", "-b:v", "0"]
    if encoder == "h264_qsv":
        return ["-preset", "veryfast", "-global_quality", "29"]
    if encoder == "h264_amf":
        return ["-quality", "speed", "-rc", "cqp", "-qp_i", "26", "-qp_p", "29"]
    if encoder == "h264_videotoolbox":
        return ["-q:v", "55"]
    return ["-preset", "veryfast", "-crf", "26"]  # libx264 fallback


# Codecs routed to the NVIDIA cuvid hardware decoder. CRITICAL for AV1:
# ffmpeg's `-hwaccel auto` does NOT pick a GPU decoder for AV1 — it silently
# falls back to the libaom *software* reference decoder (~2x realtime for 4K),
# which dominates the entire export. Forcing av1_cuvid is ~6x faster; h264/hevc
# cuvid are ~1.4-1.8x faster than -hwaccel auto too. (Measured on the real
# sources.) Gated to 8-bit yuv420p so NVENC never has to convert off the GPU.
_CUVID_BY_CODEC = {
    "h264": "h264_cuvid", "hevc": "hevc_cuvid", "av1": "av1_cuvid",
    "vp9": "vp9_cuvid", "mpeg2video": "mpeg2_cuvid", "vc1": "vc1_cuvid",
}


@functools.lru_cache
def _available_cuvid() -> frozenset:
    try:
        out = subprocess.run(
            ["ffmpeg", "-hide_banner", "-decoders"], capture_output=True, text=True
        ).stdout
        return frozenset(d for d in set(_CUVID_BY_CODEC.values()) if f" {d} " in out)
    except Exception:
        return frozenset()


@functools.lru_cache
def _probe_codec(path: str) -> tuple:
    """(codec_name, pix_fmt) of the first video stream, or ('', '')."""
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "v:0",
             "-show_entries", "stream=codec_name,pix_fmt", "-of", "default=nw=1:nk=1", path],
            capture_output=True, text=True, timeout=15,
        ).stdout.split()
        return (out[0] if out else "", out[1] if len(out) > 1 else "")
    except Exception:
        return ("", "")


@functools.lru_cache
def _has_audio_stream(path: str) -> bool:
    """True if the file has at least one audio stream. The authoritative answer
    for whether a clip's audio should be exported — the frontend's `hasAudio`
    flag is derived from a waveform extraction that can fail/lag on large files,
    silently dropping audio from the export."""
    if not path:
        return False
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "a",
             "-show_entries", "stream=index", "-of", "csv=p=0", path],
            capture_output=True, text=True, timeout=15,
        ).stdout.strip()
        return bool(out)
    except Exception:
        return False


def cuvid_decoder_for(path: str, encoder: str) -> str | None:
    """The cuvid hardware decoder for this input, or None to let ffmpeg pick.

    Only when a working NVENC confirms an NVIDIA GPU is present, the source is an
    8-bit codec cuvid handles, and that decoder is in the build. Fails closed
    (returns None) on an unknown pixel format so we never force a decoder that
    might hand NVENC a 10-bit frame it would have to download and convert."""
    if encoder != "h264_nvenc":
        return None
    codec, pix_fmt = _probe_codec(path)
    dec = _CUVID_BY_CODEC.get(codec)
    if not dec or dec not in _available_cuvid():
        return None
    if pix_fmt not in ("yuv420p", "yuvj420p"):
        return None
    return dec


def _atempo_chain(speed: float) -> str:
    """atempo only accepts 0.5–2.0; chain factors to reach any speed."""
    speed = max(0.01, speed)
    if abs(speed - 1.0) < 1e-3:
        return ""
    factors: list[float] = []
    remaining = speed
    while remaining > 2.0:
        factors.append(2.0)
        remaining /= 2.0
    while remaining < 0.5:
        factors.append(0.5)
        remaining /= 0.5
    factors.append(remaining)
    return "".join(f"atempo={f:.4f}," for f in factors)


def _eff_dur(clip: dict) -> float:
    speed = max(0.01, float(clip.get("speed", 1)))
    return (float(clip["outPointSec"]) - float(clip["inPointSec"])) / speed


def _fades(clip: dict, eff_dur: float) -> str:
    parts = []
    for eff in clip.get("effects", []):
        if eff.get("type") not in ("fade-in", "fade-out"):
            continue
        d = float(eff.get("params", {}).get("duration", 0.6) or 0.6)
        d = max(0.05, min(d, eff_dur / 2))
        if eff["type"] == "fade-in":
            parts.append(f"fade=t=in:st=0:d={d:.3f}:alpha=1")
        else:
            parts.append(f"fade=t=out:st={max(0.0, eff_dur - d):.3f}:d={d:.3f}:alpha=1")
    return ",".join(parts)


def _zoom_expr(clip: dict, eff_dur: float) -> str:
    """FFmpeg expression for the clip's time-varying zoom factor, or "".

    Mirrors the browser's resolveClipTransformAt: each zoom effect contributes
    a factor of 1+A*smoothstep(t/D) (zoom-in) or 1+A*(1-smoothstep) (zoom-out),
    A clamped to [0.05, 1]; multiple zoom effects multiply. `t` in the output is
    clip-local seconds (the chain trims/setpts before this filter runs).
    Commas are escaped for use inside a quoted filter argument.
    """
    factors: list[str] = []
    for eff in clip.get("effects", []):
        kind = eff.get("type")
        if kind not in ("zoom-in", "zoom-out"):
            continue
        amount = (eff.get("params", {}) or {}).get("amount", 0.24)
        try:
            amount = float(amount)
        except (TypeError, ValueError):
            amount = 0.24
        amount = max(0.05, min(1.0, amount))
        d = max(eff_dur, 1e-6)
        p = f"clip(t/{d:.4f}\\,0\\,1)"
        ss = f"({p}*{p}*(3-2*{p}))"  # smoothstep, same curve as the preview
        if kind == "zoom-in":
            factors.append(f"(1+{amount:.4f}*{ss})")
        else:
            factors.append(f"(1+{amount:.4f}*(1-{ss}))")
    return "*".join(factors)


def _visual_chain(clip: dict, src: str, w: int, h: int, label: str) -> str:
    t = clip.get("transform", {}) or {}
    scale = float(t.get("scale", 1)) or 1
    sx = scale * float(t.get("scaleX", 1) or 1)
    sy = scale * float(t.get("scaleY", 1) or 1)
    eff_dur = _eff_dur(clip)
    is_image = clip.get("kind") == "image"
    speed = max(0.01, float(clip.get("speed", 1)))

    chain: list[str] = []
    if is_image:
        chain.append("setpts=PTS-STARTPTS")
    else:
        # The input is already seeked to this clip's window (-ss/-t), so the
        # stream is 0-based here: just normalise PTS and apply speed (no trim).
        chain.append(f"setpts=(PTS-STARTPTS)/{speed:.5f}")

    # Crop the source first (mirrors the canvas: crop, then fit the rest). crop
    # is a fraction trimmed off each side; clamp so width/height stay positive.
    crop = t.get("crop")
    if isinstance(crop, dict):
        cl = max(0.0, min(0.49, float(crop.get("l", 0) or 0)))
        cr = max(0.0, min(0.49, float(crop.get("r", 0) or 0)))
        ct = max(0.0, min(0.49, float(crop.get("t", 0) or 0)))
        cb = max(0.0, min(0.49, float(crop.get("b", 0) or 0)))
        if cl or cr or ct or cb:
            kw = max(0.02, 1 - cl - cr)
            kh = max(0.02, 1 - ct - cb)
            chain.append(f"crop=iw*{kw:.4f}:ih*{kh:.4f}:iw*{cl:.4f}:ih*{ct:.4f}")

    # Fit (contain) to the frame, then apply the clip's scale factors.
    chain.append(
        f"scale=w='iw*min({w}/iw\\,{h}/ih)*{sx:.4f}':h='ih*min({w}/iw\\,{h}/ih)*{sy:.4f}'"
    )

    adj = clip.get("adjust", {}) or {}
    b, c, s = adj.get("brightness", 0), adj.get("contrast", 0), adj.get("saturation", 0)
    if b or c or s:
        chain.append(f"eq=brightness={b/100:.3f}:contrast={1+c/100:.3f}:saturation={1+s/100:.3f}")

    # Mirror BEFORE rotation (matches the canvas, which flips the upright image
    # then rotates). Most clips set neither.
    if t.get("flipH"):
        chain.append("hflip")
    if t.get("flipV"):
        chain.append("vflip")

    # Only convert to yuva420p when the clip actually uses transparency:
    # opacity/fades, or rotation (whose expanded corners must be transparent).
    # Most clips are fully opaque with no fades — skipping the format
    # conversion avoids processing an alpha plane that would never be used.
    opacity = float(clip.get("opacity", 1))
    fades = _fades(clip, eff_dur)
    rotation = float(t.get("rotation", 0) or 0)
    rotated = abs(rotation) > 0.01
    zoom = _zoom_expr(clip, eff_dur)
    if opacity < 0.999 or fades or rotated:
        chain.append("format=yuva420p")
    if rotated:
        # Canvas-equivalent: rotate about the clip centre, expand the canvas to
        # the rotated bounding box (the overlay then centres that box on the
        # clip anchor, pinning the image centre exactly like ctx.rotate does).
        # Positive degrees = clockwise in both canvas and ffmpeg.
        rad = rotation * math.pi / 180.0
        chain.append(f"rotate=a={rad:.6f}:ow=rotw({rad:.6f}):oh=roth({rad:.6f}):c=none")
    if zoom:
        # Time-varying uniform zoom (zoom-in/out effects). Uniform scaling
        # commutes with the static rotation above, so applying it after keeps
        # the rotate filter's geometry constant per frame.
        chain.append(f"scale=eval=frame:w='iw*{zoom}':h='ih*{zoom}'")
    if opacity < 0.999:
        chain.append(f"colorchannelmixer=aa={opacity:.3f}")
    if fades:
        chain.append(fades)

    # Shift onto the timeline so the clip plays at its startSec.
    chain.append(f"setpts=PTS+{float(clip['startSec']):.4f}/TB")
    return f"[{src}]" + ",".join(chain) + f"[{label}]"


def _finite_float(value, fallback: float) -> float:
    try:
        n = float(value)
    except (TypeError, ValueError):
        return fallback
    return n if math.isfinite(n) else fallback


def _blur_sticker_geometry(clip: dict, w: int, h: int) -> dict | None:
    fx = clip.get("fxData") or {}
    if fx.get("type") != "blur-sticker":
        return None

    rw = max(0.01, min(1.0, _finite_float(fx.get("w"), 0.28)))
    rh = max(0.01, min(1.0, _finite_float(fx.get("h"), 0.18)))
    bw = max(1, min(w, int(round(rw * w))))
    bh = max(1, min(h, int(round(rh * h))))

    cx = _finite_float(fx.get("x"), 0.5) * w
    cy = _finite_float(fx.get("y"), 0.5) * h
    x = int(round(max(0, min(w - bw, cx - bw / 2))))
    y = int(round(max(0, min(h - bh, cy - bh / 2))))

    requested_blur = max(0, min(80, int(round(_finite_float(fx.get("blurPx"), 18)))))
    pad = requested_blur * 2
    sx = max(0, x - pad)
    sy = max(0, y - pad)
    sw = min(w - sx, bw + pad * 2)
    sh = min(h - sy, bh + pad * 2)
    if sw < 3 or sh < 3:
        return None

    max_radius = max(1, (min(sw, sh) - 1) // 2)
    blur = min(requested_blur, max_radius)
    if blur < 1:
        return None

    return {
        "x": x, "y": y, "w": bw, "h": bh,
        "sx": sx, "sy": sy, "sw": sw, "sh": sh,
        "inner_x": x - sx, "inner_y": y - sy,
        "blur": blur,
    }


def _blur_sticker_filters(prev: str, clip: dict, w: int, h: int, idx: int) -> tuple[list[str], str]:
    geom = _blur_sticker_geometry(clip, w, h)
    if not geom:
        return [], prev

    start = float(clip.get("startSec", 0) or 0)
    end = start + _eff_dur(clip)
    base = f"fxbase{idx}"
    src = f"fxsrc{idx}"
    blurred = f"fxblur{idx}"
    out = f"fxout{idx}"
    blur = geom["blur"]

    parts = [
        f"[{prev}]split=2[{base}][{src}]",
        (
            f"[{src}]crop={geom['sw']}:{geom['sh']}:{geom['sx']}:{geom['sy']},"
            f"boxblur=luma_radius={blur}:luma_power=1:chroma_radius={blur}:chroma_power=1,"
            f"crop={geom['w']}:{geom['h']}:{geom['inner_x']}:{geom['inner_y']}[{blurred}]"
        ),
        (
            f"[{base}][{blurred}]overlay=x={geom['x']}:y={geom['y']}:eof_action=pass:"
            f"enable='between(t,{start:.4f},{end:.4f})'[{out}]"
        ),
    ]
    return parts, out


# Noise floor (dBFS) per denoise strength.  Higher (closer to 0) = more
# aggressive: afftdn removes everything below this threshold.
_DENOISE_NF: dict[str, int] = {"light": -30, "medium": -25, "heavy": -20}


def _audio_chain(clip: dict, src: str, label: str) -> str:
    speed = max(0.01, float(clip.get("speed", 1)))
    vol = float(clip.get("volume", 1))
    start_ms = int(float(clip["startSec"]) * 1000)
    # Input is already seeked to the clip window (-ss/-t), so no atrim needed —
    # just rebase the timestamps to zero.
    parts = ["asetpts=PTS-STARTPTS"]
    tempo = _atempo_chain(speed)
    if tempo:
        parts.append(tempo.rstrip(","))
    # Denoise before volume so the filter sees the original signal level.
    denoise = clip.get("denoise")
    if denoise in _DENOISE_NF:
        parts.append(f"afftdn=nf={_DENOISE_NF[denoise]}")
    parts.append(f"volume={vol:.3f}")
    parts.append(f"adelay={start_ms}:all=1")
    return f"[{src}]" + ",".join(parts) + f"[{label}]"


def _is_neutral_transform(t: dict | None) -> bool:
    t = t or {}
    return (
        abs(float(t.get("scale", 1) or 1) - 1) < 1e-3
        and abs(float(t.get("scaleX", 1) or 1) - 1) < 1e-3
        and abs(float(t.get("scaleY", 1) or 1) - 1) < 1e-3
        and abs(float(t.get("x", 0.5)) - 0.5) < 1e-3
        and abs(float(t.get("y", 0.5)) - 0.5) < 1e-3
        and abs(float(t.get("rotation", 0) or 0)) < 1e-2
    )


def _fast_single_clip_command(
    visual: list[dict], audio: list[dict], text: list[dict],
    asset_paths: dict[str, str],
    w: int, h: int, fps: int, duration: float, kbps: int, out_path: str,
) -> list[str] | None:
    """Direct-transcode command for the most common export: ONE untouched video
    clip covering the whole timeline (trim-and-export). Returns None when the
    timeline needs real compositing.

    The general path drags every frame through a CPU filtergraph
    (black background → scale → overlay → format) even when nothing is
    composited, which caps a hardware-encoded export at filtergraph speed.
    Skipping the graph entirely lets the decoder (NVDEC et al.) feed the
    encoder almost directly — several times faster, and what dedicated editors
    do for simple timelines.
    """
    if text or len(visual) != 1:
        return None
    c = visual[0]
    if c.get("kind") != "video":
        return None
    path = asset_paths.get(c.get("assetId") or "")
    if not path:
        return None
    # The clip must play 1:1 over the full timeline with no visual treatment.
    if abs(float(c.get("speed", 1) or 1) - 1) > 1e-3:
        return None
    if float(c.get("startSec", 0) or 0) > 1e-3:
        return None
    if _eff_dur(c) < duration - 0.05:
        return None
    if float(c.get("opacity", 1)) < 0.999:
        return None
    if c.get("effects"):
        return None
    adj = c.get("adjust") or {}
    if adj.get("brightness") or adj.get("contrast") or adj.get("saturation"):
        return None
    if not _is_neutral_transform(c.get("transform")):
        return None
    # Audio must be the same clip, untouched (or absent entirely).
    if c.get("denoise") or abs(float(c.get("volume", 1)) - 1) > 1e-3:
        return None
    if len(audio) > 1 or (len(audio) == 1 and audio[0].get("id") != c.get("id")):
        return None
    want_audio = len(audio) == 1

    # The source must land exactly on the output geometry (same aspect after
    # contain-fit) — otherwise the general path letterboxes via overlay.
    try:
        from ..ffmpeg_utils import probe
        meta = probe(path)
        sw, sh = int(meta.get("width") or 0), int(meta.get("height") or 0)
    except Exception:
        return None
    if sw <= 0 or sh <= 0:
        return None
    fit = min(w / sw, h / sh)
    if (round(sw * fit), round(sh * fit)) != (w, h):
        return None

    encoder = detect_video_encoder()
    needs_scale = (sw, sh) != (w, h)
    # GPU decode via the cuvid decoder, which `-resize` lets scale during decode.
    # This is what makes a 4K (esp. AV1) export fast: `-hwaccel auto` would decode
    # AV1 in software (libaom, ~2x realtime) — the dominant cost of the export.
    dec = cuvid_decoder_for(path, encoder)
    logging.getLogger(__name__).info(
        "Export fast path: single full-frame clip → direct transcode (%s%s)",
        encoder, f", {dec}" if dec else "",
    )
    cmd: list[str] = ["ffmpeg", "-hide_banner", "-y"]
    if dec:
        cmd += ["-c:v", dec]
        if needs_scale:
            cmd += ["-resize", f"{w}x{h}"]  # GPU-side scale during decode
    elif encoder != "libx264":
        cmd += ["-hwaccel", "auto"]  # HW decode; silent SW fallback per input
    in_pt = float(c.get("inPointSec", 0) or 0)
    if in_pt > 1e-3:
        # Input seeking: jumps to the nearest prior keyframe then decodes up to
        # the exact point — fast AND frame-accurate for a re-encode.
        cmd += ["-ss", f"{in_pt:.4f}"]
    cmd += ["-i", path]
    if needs_scale and not dec:
        cmd += ["-vf", f"scale={w}:{h}"]  # CPU scale only when no GPU decoder
    cmd += ["-c:v", encoder, "-b:v", f"{kbps}k"]
    if encoder == "libx264":
        cmd += ["-preset", "veryfast"]
    elif encoder == "h264_nvenc":
        cmd += ["-preset", "p4", "-rc", "vbr"]
    cmd += ["-pix_fmt", "yuv420p", "-r", str(fps), "-t", f"{duration:.4f}"]
    if want_audio:
        cmd += ["-c:a", "aac", "-b:a", "128k", "-ac", "2"]
    else:
        cmd += ["-an"]
    cmd += ["-movflags", "+faststart", out_path]
    return cmd


def _clips_mergeable(a: dict, b: dict) -> bool:
    """True if clip `b` is a seamless continuation of `a` that can be played as
    one clip. The scene-split feature cuts one source into many contiguous
    segments; exporting them as separate overlay layers builds an N-deep
    filtergraph (split + overlay + amix per segment) that blows up memory on a
    long video. When the user hasn't edited the pieces, collapsing each run back
    into one clip is exact — same source, same treatment, no gap."""
    if a.get("kind") != b.get("kind") or a.get("kind") not in ("video", "audio"):
        return False
    if a.get("trackId") != b.get("trackId"):
        return False
    aid = a.get("assetId") or ""
    if not aid or aid != (b.get("assetId") or ""):
        return False
    if abs(float(a.get("speed", 1) or 1) - float(b.get("speed", 1) or 1)) > 1e-6:
        return False
    if a.get("effects") or b.get("effects"):
        return False
    if bool(a.get("muted")) != bool(b.get("muted")):
        return False
    if abs(float(a.get("opacity", 1)) - float(b.get("opacity", 1))) > 1e-6:
        return False
    if abs(float(a.get("volume", 1)) - float(b.get("volume", 1))) > 1e-6:
        return False
    if (a.get("denoise") or None) != (b.get("denoise") or None):
        return False
    if (a.get("transform") or {}) != (b.get("transform") or {}):
        return False
    if (a.get("adjust") or {}) != (b.get("adjust") or {}):
        return False
    # Contiguous in the source AND on the timeline (no trim gap, no slide).
    if abs(float(b.get("inPointSec", 0)) - float(a.get("outPointSec", 0))) > 1e-3:
        return False
    if abs(float(b.get("startSec", 0)) - (float(a.get("startSec", 0)) + _eff_dur(a))) > 1e-3:
        return False
    return True


def _merge_contiguous_runs(clips: list[dict]) -> list[dict]:
    """Collapse adjacent same-source segments (see _clips_mergeable) into single
    clips. Order-independent: clips are grouped per (track, kind, asset), sorted
    by start, and merged where seamless. Images and text pass through untouched."""
    from collections import defaultdict

    groups: dict[tuple, list[dict]] = defaultdict(list)
    passthrough: list[dict] = []
    for c in clips:
        if c.get("kind") in ("video", "audio") and c.get("assetId"):
            groups[(c.get("trackId"), c.get("kind"), c.get("assetId"))].append(c)
        else:
            passthrough.append(c)

    merged: list[dict] = []
    for group in groups.values():
        group.sort(key=lambda c: float(c.get("startSec", 0) or 0))
        run = dict(group[0])
        for nxt in group[1:]:
            if _clips_mergeable(run, nxt):
                run["outPointSec"] = nxt.get("outPointSec")
            else:
                merged.append(run)
                run = dict(nxt)
        merged.append(run)
    return merged + passthrough


def build_command(
    spec: dict, asset_paths: dict[str, str], out_path: str, work_dir: str
) -> list[str]:
    w = int(spec["width"])
    h = int(spec["height"])
    fps = int(spec.get("fps", 30))
    duration = float(spec["durationSec"])
    kbps = int(spec.get("videoBitrateKbps", 8000))

    tracks = spec.get("tracks", [])
    track_index = {t["id"]: i for i, t in enumerate(tracks)}
    muted_track = {t["id"]: bool(t.get("muted")) for t in tracks}

    # Collapse scene-split runs back into whole clips before anything else — this
    # is what keeps "split then export" from building a filtergraph so deep it
    # OOMs ffmpeg (esp. with burned captions on top).
    clips = _merge_contiguous_runs(spec.get("clips", []))
    visual = [c for c in clips if c.get("kind") in ("video", "image")]
    # Bottom track (higher index) drawn first; top track (lower index) ends on top.
    visual.sort(key=lambda c: (-track_index.get(c["trackId"], 0), float(c["startSec"])))
    fx = [
        c for c in clips
        if c.get("kind") == "fx" and (c.get("fxData") or {}).get("type") == "blur-sticker"
    ]
    fx.sort(key=lambda c: (-track_index.get(c["trackId"], 0), float(c["startSec"])))

    # Include a clip's audio when it isn't muted and the SOURCE actually has an
    # audio stream (backend probe — authoritative). Falling back to the
    # frontend `hasAudio` flag alone silently dropped audio whenever its
    # waveform-based heuristic hadn't populated (common on big/slow sources).
    audio = [
        c for c in clips
        if c.get("kind") in ("video", "audio")
        and not c.get("muted")
        and not muted_track.get(c["trackId"], False)
        and (c.get("hasAudio") or _has_audio_stream(asset_paths.get(c.get("assetId") or "")))
    ]
    text = [c for c in clips if c.get("kind") == "text" and c.get("textData")]

    # Simple trim-and-export timelines skip the compositing graph entirely.
    if not fx:
        fast = _fast_single_clip_command(
            visual, audio, text, asset_paths, w, h, fps, duration, kbps, out_path
        )
        if fast is not None:
            return fast

    # --- inputs (deduplicated by source path) ---
    # Per-input GPU decoder selection: force the cuvid decoder for video sources
    # it supports (esp. AV1, which -hwaccel auto decodes in slow software). The
    # decoded frames feed the CPU filtergraph below; only the decode runs on the
    # GPU, but for a 4K AV1 source that decode is the whole bottleneck.
    #
    # Clips that share a source file (e.g. the segments produced by a scene
    # split) share ONE ffmpeg input. Opening the file once per clip meant an
    # N-way split decoded a multi-GB source N times in parallel — the export then
    # sat at 0% for minutes before emitting any progress. With one decode per
    # file, the stream is fanned out to each consumer via split/asplit below.
    # Images are NOT deduplicated: each carries its own -loop/-t input args.
    encoder = detect_video_encoder()

    # Decide the decode strategy up front. Each forced cuvid / -hwaccel context
    # reserves VRAM; a handful is a big speed win but dozens crash modest GPUs,
    # so beyond a ceiling we decode in software (bounded memory, runs anywhere).
    n_video = sum(
        1 for c in clips
        if c.get("kind") == "video" and asset_paths.get(c.get("assetId") or "")
    )
    use_hw_decode = n_video <= _MAX_HW_DECODERS

    inputs: list[list[str]] = []  # each is the ffmpeg args for one input
    clip_input: dict[str, int] = {}      # clip id -> ffmpeg input index
    for c in clips:
        if c.get("kind") in ("text", "fx"):
            continue
        path = asset_paths.get(c.get("assetId") or "")
        if not path:
            continue
        clip_input[c["id"]] = len(inputs)
        if c.get("kind") == "image":
            inputs.append(["-loop", "1", "-t", f"{_eff_dur(c):.4f}", "-i", path])
            continue
        # Video: seek to the clip's in-point and read ONLY its own window at the
        # input level. Each clip decodes just the frames it uses — no whole-file
        # decode per clip (the old N-input cost) and no shared split buffer that
        # grows with the gap between two segments of one source (the OOM trap).
        # `-ss` before `-i` is fast (keyframe) and frame-accurate (ffmpeg then
        # decodes to the exact point). `-t` caps the window length.
        in_pt = float(c.get("inPointSec", 0) or 0)
        win = max(0.0, float(c.get("outPointSec", 0) or 0) - in_pt)
        pre: list[str] = []
        if use_hw_decode:
            dec = cuvid_decoder_for(path, encoder)
            if dec:
                pre = ["-c:v", dec]                       # forced GPU decoder
            elif encoder != "libx264":
                pre = ["-hwaccel", "auto"]                # generic HW decode + SW fallback
        seek = ["-ss", f"{in_pt:.4f}"] if in_pt > 1e-3 else []
        inputs.append([*pre, *seek, "-t", f"{win:.4f}", "-i", path])

    # --- filter graph ---
    parts: list[str] = [f"color=c=black:s={w}x{h}:r={fps}:d={duration:.4f}[bg]"]

    # Each clip reads its own seeked input pad directly — one decode per clip,
    # no split fan-out (which buffered frames between far-apart trims).
    vsrc = {c["id"]: f"{clip_input[c['id']]}:v" for c in visual if c["id"] in clip_input}

    prev = "bg"
    vn = 0
    for c in visual:
        if c["id"] not in clip_input:
            continue
        lbl = f"v{vn}"
        parts.append(_visual_chain(c, vsrc[c["id"]], w, h, lbl))
        start = float(c["startSec"])
        end = start + _eff_dur(c)
        t = c.get("transform", {}) or {}
        tx = float(t.get("x", 0.5))
        ty = float(t.get("y", 0.5))
        out_lbl = f"ov{vn}"
        parts.append(
            f"[{prev}][{lbl}]overlay=x='(W*{tx:.4f})-(w/2)':y='(H*{ty:.4f})-(h/2)'"
            f":eof_action=pass:enable='between(t,{start:.4f},{end:.4f})'[{out_lbl}]"
        )
        prev = out_lbl
        vn += 1

    fn = 0
    for c in fx:
        generated, out_lbl = _blur_sticker_filters(prev, c, w, h, fn)
        if not generated:
            continue
        parts.extend(generated)
        prev = out_lbl
        fn += 1

    visual_out = prev

    # Captions (ASS burn). The file is referenced by basename and the command
    # MUST be run with cwd=work_dir — this avoids fragile Windows path escaping
    # inside the filtergraph (drive-colon, backslashes).
    if text:
        ass_name = "captions.ass"
        with open(os.path.join(work_dir, ass_name), "w", encoding="utf-8") as f:
            f.write(build_ass(w, h, [
                {"startSec": c["startSec"], "durationSec": _eff_dur(c), "textData": c["textData"]}
                for c in text
            ]))
        parts.append(f"[{visual_out}]ass={ass_name}[vout]")
        vmap = "[vout]"
    else:
        # Ensure a named, encodable output even with no overlays.
        parts.append(f"[{visual_out}]format=yuv420p[vout]")
        vmap = "[vout]"

    # Audio — same one-input-per-clip story; read each clip's seeked audio pad.
    asrc = {c["id"]: f"{clip_input[c['id']]}:a" for c in audio if c["id"] in clip_input}

    amap = None
    an = 0
    for c in audio:
        if c["id"] not in clip_input:
            continue
        parts.append(_audio_chain(c, asrc[c["id"]], f"a{an}"))
        an += 1
    if an == 1:
        parts.append("[a0]anull[aout]")
        amap = "[aout]"
    elif an > 1:
        ins = "".join(f"[a{i}]" for i in range(an))
        parts.append(f"{ins}amix=inputs={an}:normalize=0:dropout_transition=0[aout]")
        amap = "[aout]"

    graph = ";".join(parts)

    # --- assemble command --- (encoder already resolved above for input decoders)

    # Thread budget: XINCHAO_EXPORT_THREADS=0 (default) → all logical CPUs minus
    # two (keeps the UI/OS responsive); positive value → exact override. The
    # old half-cores default predates the heavy-job semaphore — with renders
    # serialised there's no contention worth reserving half the machine for,
    # and the CPU filtergraph is the bottleneck of every composited export.
    _cfg_threads = get_settings().export_threads
    n_threads = _cfg_threads if _cfg_threads > 0 else max(1, (os.cpu_count() or 4) - 2)

    cmd: list[str] = ["ffmpeg", "-hide_banner", "-y"]
    # Cap the filtergraph worker threads (the main CPU consumer here).
    cmd += ["-filter_complex_threads", str(n_threads),
            "-filter_threads", str(n_threads)]
    # HW decode is selected PER INPUT above (forced cuvid decoder where the codec
    # supports it, else -hwaccel auto) — decoded frames are downloaded to system
    # memory for the CPU filtergraph.
    for inp in inputs:
        cmd += inp
    cmd += ["-filter_complex", graph, "-map", vmap]
    if amap:
        cmd += ["-map", amap]

    cmd += ["-c:v", encoder, "-b:v", f"{kbps}k"]
    if encoder == "libx264":
        # Cap encoder threads too (NVENC/QSV ignore -threads; it only matters
        # for the software x264 fallback).
        cmd += ["-preset", "veryfast", "-threads", str(n_threads)]
    elif encoder == "h264_nvenc":
        # VBR lets NVENC overshoot on complex scenes while averaging near the
        # target bitrate.  p4 (medium) balances encode speed against quality.
        cmd += ["-preset", "p4", "-rc", "vbr"]
    cmd += ["-pix_fmt", "yuv420p", "-r", str(fps), "-t", f"{duration:.4f}"]

    if amap:
        cmd += ["-c:a", "aac", "-b:a", "128k", "-ac", "2"]

    cmd += ["-movflags", "+faststart", out_path]
    return cmd
