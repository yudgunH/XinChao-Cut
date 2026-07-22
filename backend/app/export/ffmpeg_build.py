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
import threading
import time
from fractions import Fraction

from ..config import get_settings
from .ass import build_ass

_ENCODERS_BY_CODEC = {
    "h264": (["h264_nvenc", "h264_qsv", "h264_amf", "h264_videotoolbox"], ["libx264"]),
    "hevc": (["hevc_nvenc", "hevc_qsv", "hevc_amf", "hevc_videotoolbox"], ["libx265"]),
    "av1": (["av1_nvenc", "av1_qsv", "av1_amf", "av1_videotoolbox"], ["libsvtav1", "libaom-av1"]),
}

# Above this many video inputs, decode in software instead of spinning up a GPU
# (cuvid / -hwaccel) decode context per input. Each HW context reserves a chunk
# of VRAM; dozens at once exhaust it and crash the export on modest GPUs. After
# the contiguous-run merge most timelines sit at 1–3 video clips, so the GPU
# path stays the norm — this is purely a safety ceiling for pathological splits.
_MAX_HW_DECODERS = 8

# Windows caps a process command line at ~32767 chars (and exec has limits too).
# A dense scene-split timeline can build a -filter_complex graph of
# tens of thousands of characters; passed inline it overflows the limit and ffmpeg
# never starts ("[WinError 206] The filename or extension is too long"). Once the
# assembled command exceeds this length we move the graph to a -filter_complex_script
# file instead. Conservative — leaves headroom for the -progress args run_job
# prepends, the output path, per-arg quoting, and estimation slack.
_FILTERGRAPH_SCRIPT_THRESHOLD = 28000
# A single ffmpeg process with hundreds of independent decoders is unstable even
# after the graph is moved to a script. Reject before spawn with an actionable
# error; the scalable follow-up is chunk-render + concat, not OS resource roulette.
_MAX_GENERAL_INPUTS = 96
_MAX_COMMAND_CHARS = 28000


def audio_mastering_filter(spec: dict) -> str:
    preset = str(spec.get("audioMastering") or "off")
    if preset == "social":
        target = -14
    elif preset == "voice":
        target = -16
    else:
        return ""
    # loudnorm performs EBU R128-aware dynamic normalization. Resample back to
    # the export contract after its internal true-peak oversampling, then keep a
    # final -1 dBFS ceiling for codecs/players that overshoot on reconstruction.
    return (
        f"loudnorm=I={target}:TP=-1:LRA=11,"
        "aresample=48000,alimiter=limit=0.891251"
    )


def _encoder_pixel_format(enc: str, *, ten_bit: bool) -> str:
    if not ten_bit:
        return "yuv420p"
    if any(enc.endswith(suffix) for suffix in ("_nvenc", "_qsv", "_amf")):
        return "p010le"
    return "yuv420p10le"


def _encoder_works(enc: str, *, ten_bit: bool = False) -> bool:
    """A hardware encoder can be *listed* but unusable (no GPU/driver). Run a
    tiny real encode to confirm it actually works before committing to it.

    The probe is 256x256, NOT a smaller size: NVENC has a minimum encode
    resolution (≈145px wide on current drivers), so a 64x64/128x128 test fails
    with "-22 Invalid argument" on a GPU where NVENC actually works fine for real
    (≥720p) exports — a false negative that silently demoted NVENC to QSV/CPU.
    256x256 clears every HW encoder's minimum while staying fast to encode."""
    try:
        r = subprocess.run(
            [
                "ffmpeg", "-hide_banner", "-f", "lavfi", "-i",
                "color=black:s=256x256:d=0.1",
                "-frames:v", "1", "-c:v", enc,
                "-pix_fmt", _encoder_pixel_format(enc, ten_bit=ten_bit),
                "-f", "null", "-",
            ],
            capture_output=True, text=True, timeout=20,
        )
        return r.returncode == 0
    except Exception:
        return False


def _ttl_cache(ttl_seconds: float):
    """Small thread-safe TTL cache with the ``cache_clear`` API used by tests
    and the runtime re-probe endpoint. Encoder availability is external state
    (driver/session/FFmpeg can recover), so it must not be cached forever."""
    def decorate(func):
        cache: dict[tuple, tuple[float, object]] = {}
        lock = threading.RLock()

        @functools.wraps(func)
        def wrapped(*args, **kwargs):
            key = (args, tuple(sorted(kwargs.items())))
            now = time.monotonic()
            with lock:
                cached = cache.get(key)
                if cached is not None and now - cached[0] < ttl_seconds:
                    return cached[1]
                value = func(*args, **kwargs)
                cache[key] = (time.monotonic(), value)
                return value

        def cache_clear() -> None:
            with lock:
                cache.clear()

        wrapped.cache_clear = cache_clear
        return wrapped
    return decorate


@_ttl_cache(600)
def detect_video_encoder(codec: str = "h264") -> str:
    """Return the best working encoder for a requested codec family.

    Every candidate performs a tiny real encode because packaged FFmpeg builds
    can advertise a hardware encoder whose driver/session is unavailable. If a
    requested family is absent, fall back to H.264 before the long job starts.
    """
    requested = codec if codec in _ENCODERS_BY_CODEC else "h264"
    try:
        out = subprocess.run(
            ["ffmpeg", "-hide_banner", "-encoders"],
            capture_output=True,
            text=True,
            timeout=15,
        ).stdout
    except Exception:
        logging.getLogger(__name__).warning(
            "Video encoder: libx264 (CPU) — could not run `ffmpeg -encoders`"
        )
        return "libx264"
    hardware, software = _ENCODERS_BY_CODEC[requested]
    for enc in [*hardware, *software]:
        if enc in out and _encoder_works(enc):
            logging.getLogger(__name__).info(
                "Video encoder: %s (%s)", enc,
                "hardware" if enc in hardware else "software",
            )
            return enc
    if requested != "h264":
        fallback = detect_video_encoder("h264")
        logging.getLogger(__name__).warning(
            "No working %s encoder; falling back to %s", requested, fallback
        )
        return fallback
    logging.getLogger(__name__).warning(
        "Video encoder: libx264 (CPU fallback — no working hardware encoder found)"
    )
    return "libx264"


@_ttl_cache(600)
def detect_hdr10_encoder(codec: str) -> str | None:
    """Return a working 10-bit HEVC/AV1 encoder without an H.264 fallback.

    A normal 8-bit probe is insufficient: several hardware H.264/HEVC encoders
    are listed and can encode yuv420p while rejecting p010 at job start. HDR is
    therefore admitted only after a real 10-bit encode with the exact pixel
    contract used by the export command.
    """
    if codec not in {"hevc", "av1"}:
        return None
    try:
        out = subprocess.run(
            ["ffmpeg", "-hide_banner", "-encoders"],
            capture_output=True,
            text=True,
            timeout=15,
        ).stdout
    except Exception:
        return None
    hardware, software = _ENCODERS_BY_CODEC[codec]
    for enc in [*hardware, *software]:
        if enc in out and _encoder_works(enc, ten_bit=True):
            logging.getLogger(__name__).info("HDR10 encoder: %s (10-bit verified)", enc)
            return enc
    logging.getLogger(__name__).warning(
        "No working 10-bit %s encoder; HDR10 is unavailable", codec
    )
    return None


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


@functools.lru_cache
def _encoder_help(encoder: str) -> str:
    try:
        result = subprocess.run(
            ["ffmpeg", "-hide_banner", "-h", f"encoder={encoder}"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        return f"{result.stdout}\n{result.stderr}"
    except Exception:
        return ""


def _encoder_option_supported(encoder: str, option: str) -> bool:
    return option in _encoder_help(encoder)


def export_video_quality_args(
    encoder: str,
    profile: str,
    kbps: int,
    n_threads: int,
) -> list[str]:
    """Stable bitrate/preset policy shared by fast and composited exports.

    Optional hardware knobs are capability-gated against the installed FFmpeg;
    packaged and system builds expose different NVENC/QSV/AMF option sets.
    """
    quality = profile if profile in {"fast", "balanced", "quality"} else "balanced"
    args = ["-c:v", encoder, "-b:v", f"{kbps}k"]
    if encoder in {"libx264", "libx265"}:
        preset = {"fast": "veryfast", "balanced": "fast", "quality": "medium"}[quality]
        return [*args, "-preset", preset, "-threads", str(n_threads)]
    if encoder.endswith("_nvenc"):
        preset = {"fast": "p3", "balanced": "p5", "quality": "p6"}[quality]
        args += ["-preset", preset, "-rc", "vbr"]
        optional: list[tuple[str, list[str]]] = []
        if quality != "fast":
            optional.extend([
                ("spatial-aq", ["-spatial-aq", "1"]),
                ("aq-strength", ["-aq-strength", "8"]),
            ])
        if quality == "quality":
            optional.extend([
                ("temporal-aq", ["-temporal-aq", "1"]),
                ("rc-lookahead", ["-rc-lookahead", "20"]),
                ("multipass", ["-multipass", "fullres"]),
                ("b_ref_mode", ["-b_ref_mode", "middle"]),
            ])
        for option, values in optional:
            if _encoder_option_supported(encoder, option):
                args += values
        return args
    if encoder.endswith("_qsv"):
        args += ["-preset", {"fast": "faster", "balanced": "medium", "quality": "slow"}[quality]]
        if quality != "fast" and _encoder_option_supported(encoder, "look_ahead"):
            args += ["-look_ahead", "1"]
        return args
    if encoder.endswith("_amf"):
        args += ["-quality", {"fast": "speed", "balanced": "balanced", "quality": "quality"}[quality]]
        if _encoder_option_supported(encoder, "vbr_peak"):
            args += ["-rc", "vbr_peak"]
        return args
    if encoder.endswith("_videotoolbox"):
        return [*args, "-realtime", "true" if quality == "fast" else "false"]
    if encoder == "libsvtav1":
        return [
            *args, "-preset", {"fast": "10", "balanced": "8", "quality": "6"}[quality],
            "-threads", str(n_threads),
        ]
    if encoder == "libaom-av1":
        return [
            *args, "-cpu-used", {"fast": "8", "balanced": "6", "quality": "4"}[quality],
            "-row-mt", "1", "-threads", str(n_threads),
        ]
    return args


def output_color_args(encoder: str, dynamic_range: str) -> list[str]:
    """Return a truthful pixel-format and colour-signalling contract."""
    if dynamic_range == "hdr10":
        if codec_family_for_encoder(encoder) not in {"hevc", "av1"}:
            raise ValueError("HDR10 requires a verified 10-bit HEVC or AV1 encoder")
        pix_fmt = _encoder_pixel_format(encoder, ten_bit=True)
        return [
            "-pix_fmt", pix_fmt,
            "-color_primaries", "bt2020",
            "-color_trc", "smpte2084",
            "-colorspace", "bt2020nc",
            "-color_range", "tv",
        ]
    return [
        "-pix_fmt", "yuv420p",
        "-color_primaries", "bt709",
        "-color_trc", "bt709",
        "-colorspace", "bt709",
        "-color_range", "tv",
    ]


def _is_hdr10_meta(meta: dict) -> bool:
    return _hdr_transfer(meta) == "pq"


def _hdr_transfer(meta: dict) -> str | None:
    base = (
        "10" in str(meta.get("pixFmt") or "")
        and str(meta.get("colorPrimaries") or "") == "bt2020"
        and str(meta.get("colorSpace") or "") in {"bt2020nc", "bt2020ncl"}
    )
    if not base:
        return None
    transfer = str(meta.get("colorTransfer") or "")
    if transfer == "smpte2084":
        return "pq"
    if transfer == "arib-std-b67":
        return "hlg"
    return None


def _is_hdr_meta(meta: dict) -> bool:
    return _hdr_transfer(meta) is not None


# CPU zscale/tonemap path used whenever an HDR10 source enters an SDR export.
# Doing only `format=yuv420p` clips PQ code values and can also leave BT.2020/PQ
# tags on an 8-bit file. This produces a real Rec.709 display-referred signal.
_HDR_TO_SDR_FILTER = (
    "zscale=t=linear:npl=100,format=gbrpf32le,"
    "zscale=p=bt709,tonemap=tonemap=hable:desat=0,"
    "zscale=t=bt709:m=bt709:r=tv,format=yuv420p"
)

# Backwards-compatible private alias for downstream tests/extensions.
_HDR10_TO_SDR_FILTER = _HDR_TO_SDR_FILTER


def hdr_metadata_args(encoder: str, meta: dict) -> list[str]:
    """Best-effort preservation of HDR10 mastering/content-light metadata.

    FFmpeg carries decoded frame side data through the simple fast path. NVENC
    needs ``extra_sei`` enabled to write it into the output bitstream; software
    HEVC/AV1 encoders consume the frame metadata directly. Unsupported encoder
    options are never emitted.
    """
    if not _is_hdr10_meta(meta):
        return []
    if encoder.endswith("_nvenc") and _encoder_option_supported(encoder, "extra_sei"):
        return ["-extra_sei", "1"]
    if encoder == "libx265":
        params: list[str] = []
        mastering = meta.get("masteringDisplay") or {}

        def scaled(key: str, scale: int) -> int | None:
            value = mastering.get(key)
            if value is None:
                return None
            try:
                return round(float(Fraction(str(value))) * scale)
            except (ValueError, ZeroDivisionError):
                return None

        values = {
            key: scaled(key, 50_000)
            for key in (
                "green_x", "green_y", "blue_x", "blue_y", "red_x", "red_y",
                "white_point_x", "white_point_y",
            )
        }
        max_luminance = scaled("max_luminance", 10_000)
        min_luminance = scaled("min_luminance", 10_000)
        if all(value is not None for value in values.values()) and None not in {
            max_luminance, min_luminance
        }:
            params.append(
                "master-display="
                f"G({values['green_x']},{values['green_y']})"
                f"B({values['blue_x']},{values['blue_y']})"
                f"R({values['red_x']},{values['red_y']})"
                f"WP({values['white_point_x']},{values['white_point_y']})"
                f"L({max_luminance},{min_luminance})"
            )
        light = meta.get("contentLightLevel") or {}
        try:
            max_content = int(light.get("max_content"))
            max_average = int(light.get("max_average"))
        except (TypeError, ValueError):
            max_content = max_average = 0
        if max_content > 0 and max_average > 0:
            params.append(f"max-cll={max_content},{max_average}")
        if params:
            return ["-x265-params", ":".join(params)]
    return []


def codec_family_for_encoder(encoder: str) -> str:
    if encoder == "copy":
        return "copy"
    if encoder.startswith("hevc_") or encoder == "libx265":
        return "hevc"
    if encoder.startswith("av1_") or encoder in {"libsvtav1", "libaom-av1"}:
        return "av1"
    return "h264"


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


@_ttl_cache(600)
def _available_cuvid() -> frozenset:
    try:
        out = subprocess.run(
            ["ffmpeg", "-hide_banner", "-decoders"],
            capture_output=True,
            text=True,
            timeout=15,
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
    if not encoder.endswith("_nvenc"):
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


def _animation_offset(clip: dict) -> float:
    return max(0.0, float(clip.get("_animationOffsetSec", 0) or 0))


def _animation_duration(clip: dict, fallback: float | None = None) -> float:
    if "_animationDurationSec" in clip:
        value = clip.get("_animationDurationSec")
    elif fallback is not None:
        value = fallback
    else:
        value = _eff_dur(clip)
    return max(1e-6, float(value or 0))


def _animation_time(clip: dict, variable: str) -> str:
    offset = _animation_offset(clip)
    return f"({variable}+{offset:.6f})" if offset > 1e-9 else variable


def _slice_clips_for_chunk(
    clips: list[dict],
    start: float,
    end: float,
    *,
    seam_fade_in_sec: float = 0,
    seam_fade_out_sec: float = 0,
) -> list[dict]:
    """Rebase clips into a time chunk without restarting their animations."""
    sliced: list[dict] = []
    for original in clips:
        clip_start = float(original.get("startSec", 0) or 0)
        original_duration = _eff_dur(original)
        clip_end = clip_start + original_duration
        left = max(start, clip_start)
        right = min(end, clip_end)
        if right <= left + 1e-9:
            continue
        offset = left - clip_start
        duration = right - left
        speed = max(0.01, float(original.get("speed", 1) or 1))
        in_point = float(original.get("inPointSec", 0) or 0) + offset * speed
        clip = dict(original)
        clip["startSec"] = left - start
        clip["inPointSec"] = in_point
        clip["outPointSec"] = in_point + duration * speed
        clip["_animationOffsetSec"] = _animation_offset(original) + offset
        clip["_animationDurationSec"] = _animation_duration(original)
        # User/voice edge fades belong only to the real clip boundaries. A
        # chunk cut through the middle must not replay them and create periodic
        # volume dips on long audio.
        if left > clip_start + 1e-9:
            clip.pop("audioFadeInSec", None)
        if right < clip_end - 1e-9:
            clip.pop("audioFadeOutSec", None)
        # Speed/denoise filters carry state. Restarting them in the middle of a
        # continuous source can produce a click; soften only that input rather
        # than dipping the complete audio mix at every chunk boundary.
        stateful_audio = (
            original.get("kind") in ("video", "audio")
            and (
                bool(original.get("denoise"))
                or abs(float(original.get("speed", 1) or 1) - 1) > 1e-6
            )
        )
        if stateful_audio and clip_start < start < clip_end and seam_fade_in_sec > 0:
            clip["_seamFadeInSec"] = seam_fade_in_sec
        if stateful_audio and clip_start < end < clip_end and seam_fade_out_sec > 0:
            clip["_seamFadeOutSec"] = seam_fade_out_sec
        sliced.append(clip)
    return sliced


def _caption_font_map(spec: dict) -> dict:
    """css family → {assFamily, sizeScale} from the spec's captionFonts (see
    build_ass docstring). Empty when the frontend shipped no fonts."""
    out: dict = {}
    for f in spec.get("captionFonts") or []:
        fam = str((f or {}).get("family") or "").strip()
        if not fam:
            continue
        out[fam] = {
            "assFamily": str(f.get("assFamily") or "").strip() or None,
            "sizeScale": _finite_float(f.get("sizeScale"), 1.0),
        }
    return out


def _ass_vf(work_dir: str, ass_name: str) -> str:
    """The `ass=` video filter for a job-local ASS file (cwd=work_dir). When the
    job ships caption fonts (<work_dir>/fonts, written by the export router),
    point libass at them via fontsdir so the burn uses the same faces as the
    canvas preview instead of a system fallback."""
    if os.path.isdir(os.path.join(work_dir, "fonts")):
        return f"ass={ass_name}:fontsdir=fonts"
    return f"ass={ass_name}"


def _ass_clip(c: dict) -> dict:
    """Shape a text clip for build_ass — carries opacity + effects so libass can
    reproduce static opacity and fade-in/out (the rest is in textData)."""
    return {
        "startSec": c["startSec"],
        "durationSec": _eff_dur(c),
        "opacity": c.get("opacity", 1),
        "effects": c.get("effects") or [],
        "textData": c["textData"],
        "_animationOffsetSec": _animation_offset(c),
        "_animationDurationSec": _animation_duration(c),
    }


def _fades(clip: dict, eff_dur: float) -> str:
    parts = []
    animation_duration = _animation_duration(clip, eff_dur)
    offset = _animation_offset(clip)
    for eff in clip.get("effects", []):
        if eff.get("type") not in ("fade-in", "fade-out"):
            continue
        d = float(eff.get("params", {}).get("duration", 0.6) or 0.6)
        d = max(0.05, min(d, animation_duration / 2))
        if "_animationDurationSec" in clip:
            if eff["type"] == "fade-in":
                if offset < d:
                    # FFmpeg rejects negative fade start times. If a boundary
                    # lands inside the short fade window, continue over the
                    # remaining duration rather than replaying the full fade.
                    parts.append(
                        f"fade=t=in:st=0:d={max(0.001, d - offset):.3f}:alpha=1"
                    )
            else:
                local_start = animation_duration - d - offset
                remaining = animation_duration - offset
                if remaining > 0:
                    parts.append(
                        f"fade=t=out:st={max(0.0, local_start):.3f}:"
                        f"d={max(0.001, min(d, remaining)):.3f}:alpha=1"
                    )
            continue
        if eff["type"] == "fade-in":
            parts.append(f"fade=t=in:st=0:d={d:.3f}:alpha=1")
        else:
            parts.append(
                f"fade=t=out:st={animation_duration - d:.3f}:d={d:.3f}:alpha=1"
            )
    return ",".join(parts)


def _adjust_filters(b: float, c: float, s: float, gate: str = "") -> list[str]:
    """Colour adjust matching the canvas/GPU renderers.

    The canvas uses CSS `brightness(k)` = MULTIPLY each channel by k; ffmpeg's
    `eq=brightness=` is an ADDITIVE luma offset — a completely different curve
    (it lifts blacks to grey instead of scaling them), so bright/dark grades
    never matched the preview. Multiply via colorchannelmixer (the same
    technique the blur-fill darken uses), then eq for contrast/saturation whose
    0.5-pivot maths do line up with CSS contrast()/saturate().
    """
    suffix = f":{gate}" if gate else ""
    out: list[str] = []
    if b:
        k = max(0.0, 1 + float(b) / 100)
        out.append(f"colorchannelmixer=rr={k:.3f}:gg={k:.3f}:bb={k:.3f}{suffix}")
    if c or s:
        out.append(f"eq=contrast={1 + float(c) / 100:.3f}:saturation={max(0.0, 1 + float(s) / 100):.3f}{suffix}")
    return out


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
        d = _animation_duration(clip, eff_dur)
        p = f"clip({_animation_time(clip, 't')}/{d:.4f}\\,0\\,1)"
        ss = f"({p}*{p}*(3-2*{p}))"  # smoothstep, same curve as the preview
        if kind == "zoom-in":
            factors.append(f"(1+{amount:.4f}*{ss})")
        else:
            factors.append(f"(1+{amount:.4f}*(1-{ss}))")
    return "*".join(factors)


def _kf_track(clip: dict, prop: str) -> list | None:
    """Non-empty keyframe track for `prop`, sorted by time, or None."""
    kf = clip.get("keyframes") or {}
    track = kf.get(prop)
    if isinstance(track, list) and len(track) > 0:
        return sorted(track, key=lambda k: float(k.get("t", 0) or 0))
    return None


def _kf_value_expr(track: list, tvar: str) -> str:
    """FFmpeg expression for a keyframe track's value at clip-local time `tvar`,
    matching the preview's interpKeyframes: hold the endpoints, ease each segment
    (smoothstep by default, linear when the segment's keyframe says so). Commas
    are escaped for use inside a quoted filter argument.
    """
    pts = track
    n = len(pts)

    def num(x) -> str:
        return f"{float(x):.6f}"

    if n == 1:
        return num(pts[0].get("v", 0))

    expr = num(pts[-1].get("v", 0))  # tvar >= last keyframe → hold last value
    for i in range(n - 2, -1, -1):
        a, b = pts[i], pts[i + 1]
        ta, tb = float(a.get("t", 0) or 0), float(b.get("t", 0) or 0)
        va, vb = float(a.get("v", 0) or 0), float(b.get("v", 0) or 0)
        if tb - ta <= 1e-6:
            seg = num(vb)
        else:
            f = f"clip(({tvar}-{ta:.6f})/{(tb - ta):.6f}\\,0\\,1)"
            ease = b.get("ease") or "easeInOut"
            e = f if ease == "linear" else f"({f}*{f}*(3-2*{f}))"
            seg = f"({va:.6f}+({(vb - va):.6f})*{e})"
        expr = f"if(lt({tvar}\\,{tb:.6f})\\,{seg}\\,{expr})"
    t0 = float(pts[0].get("t", 0) or 0)
    return f"if(lt({tvar}\\,{t0:.6f})\\,{num(pts[0].get('v', 0))}\\,{expr})"


def _opacity_fade_filters(op_kf: list, eff_dur: float) -> list[str] | None:
    """If an opacity keyframe track is a plain fade (ramp 0→1 and/or 1→0, fully
    opaque in the middle), express it with the cheap `fade` filter instead of the
    per-pixel `geq`. Returns the fade filter string(s), or None when the curve
    isn't a simple fade (caller falls back to geq). Times are clip-local.
    """
    eps = 0.02
    pts = sorted(op_kf, key=lambda k: float(k.get("t", 0) or 0))
    ts = [max(0.0, float(k.get("t", 0) or 0)) for k in pts]
    vs = [max(0.0, min(1.0, float(k.get("v", 0) or 0))) for k in pts]
    if len(pts) < 2:
        return None
    full = [i for i, v in enumerate(vs) if v >= 1 - eps]
    if not full:
        return None  # never fully opaque → fade (which targets 1) can't represent it
    rise_end, fall_start = full[0], full[-1]  # plateau spans [rise_end, fall_start]
    # Unimodal: non-decreasing into the plateau, fully opaque across it, non-increasing out.
    if any(vs[i] < vs[i - 1] - eps for i in range(1, rise_end + 1)):
        return None
    if any(v < 1 - eps for v in vs[rise_end:fall_start + 1]):
        return None
    if any(vs[i] > vs[i - 1] + eps for i in range(fall_start + 1, len(vs))):
        return None
    out: list[str] = []
    if rise_end > 0:  # there is a rise
        if vs[0] > eps:
            return None  # starts partly visible → not a clean fade-in
        d = ts[rise_end] - ts[0]
        if d > 0.01:
            out.append(f"fade=t=in:st={ts[0]:.4f}:d={d:.4f}:alpha=1")
    if fall_start < len(vs) - 1:  # there is a fall
        if vs[-1] > eps:
            return None  # ends partly visible → not a clean fade-out
        d = ts[-1] - ts[fall_start]
        if d > 0.01:
            out.append(f"fade=t=out:st={ts[fall_start]:.4f}:d={d:.4f}:alpha=1")
    return out or None


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

    # Fit (contain) to the frame, then apply the clip's scale factors. When
    # scale/scaleX/scaleY are keyframed, the factors become time-varying
    # expressions (clip-local `t`), matching the preview's per-frame transform.
    scale_kf, sxk, syk = _kf_track(clip, "scale"), _kf_track(clip, "scaleX"), _kf_track(clip, "scaleY")
    fit = f"min({w}/iw\\,{h}/ih)"
    if scale_kf or sxk or syk:
        anim_t = _animation_time(clip, "t")
        s_expr = _kf_value_expr(scale_kf, anim_t) if scale_kf else f"{scale:.4f}"
        sx_expr = f"({s_expr})*({_kf_value_expr(sxk, anim_t)})" if sxk else f"({s_expr})*{float(t.get('scaleX', 1) or 1):.4f}"
        sy_expr = f"({s_expr})*({_kf_value_expr(syk, anim_t)})" if syk else f"({s_expr})*{float(t.get('scaleY', 1) or 1):.4f}"
        chain.append(f"scale=eval=frame:w='iw*{fit}*{sx_expr}':h='ih*{fit}*{sy_expr}'")
    else:
        chain.append(f"scale=w='iw*{fit}*{sx:.4f}':h='ih*{fit}*{sy:.4f}'")

    adj = clip.get("adjust", {}) or {}
    b, c, s = adj.get("brightness", 0), adj.get("contrast", 0), adj.get("saturation", 0)
    if b or c or s:
        chain.extend(_adjust_filters(b, c, s))

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
    op_kf = _kf_track(clip, "opacity")
    fades = _fades(clip, eff_dur)
    rotation = float(t.get("rotation", 0) or 0)
    rot_kf = _kf_track(clip, "rotation")
    rotated = abs(rotation) > 0.01 or rot_kf is not None
    zoom = _zoom_expr(clip, eff_dur)
    if opacity < 0.999 or fades or rotated or op_kf is not None:
        chain.append("format=yuva420p")
    if rotated:
        # Canvas-equivalent: rotate about the clip centre, expand the canvas to
        # the rotated bounding box (the overlay then centres that box on the
        # clip anchor, pinning the image centre exactly like ctx.rotate does).
        # Positive degrees = clockwise in both canvas and ffmpeg.
        deg2rad = math.pi / 180.0
        if rot_kf:
            # Time-varying angle (clip-local `t`); size the canvas to the largest
            # angle so no frame clips as it spins.
            ang_expr = f"({_kf_value_expr(rot_kf, _animation_time(clip, 't'))})*{deg2rad:.8f}"
            max_rad = max(abs(float(k.get("v", 0) or 0)) for k in rot_kf) * deg2rad
            chain.append(f"rotate=a='{ang_expr}':ow=rotw({max_rad:.6f}):oh=roth({max_rad:.6f}):c=none")
        else:
            rad = rotation * deg2rad
            chain.append(f"rotate=a={rad:.6f}:ow=rotw({rad:.6f}):oh=roth({rad:.6f}):c=none")
    if zoom:
        # Time-varying uniform zoom (zoom-in/out effects). Uniform scaling
        # commutes with the static rotation above, so applying it after keeps
        # the rotate filter's geometry constant per frame.
        chain.append(f"scale=eval=frame:w='iw*{zoom}':h='ih*{zoom}'")
    if op_kf:
        # A plain fade ramp → the cheap `fade` filter; anything else → per-pixel
        # geq (scale the alpha by the keyframe value at each frame's time T).
        fade_filters = (
            None if "_animationDurationSec" in clip
            else _opacity_fade_filters(op_kf, eff_dur)
        )
        if fade_filters is not None:
            chain.extend(fade_filters)
        else:
            op_expr = _kf_value_expr(op_kf, _animation_time(clip, "T"))
            chain.append(
                "geq=lum='lum(X\\,Y)':cb='cb(X\\,Y)':cr='cr(X\\,Y)':"
                f"a='alpha(X\\,Y)*clip({op_expr}\\,0\\,1)'"
            )
    elif opacity < 0.999:
        chain.append(f"colorchannelmixer=aa={opacity:.3f}")
    if fades:
        chain.append(fades)

    # Shift onto the timeline so the clip plays at its startSec.
    chain.append(f"setpts=PTS+{float(clip['startSec']):.4f}/TB")
    return f"[{src}]" + ",".join(chain) + f"[{label}]"


def _canvas_fill_filters(
    prev: str, clip: dict, src: str, w: int, h: int, idx: int
) -> tuple[list[str], str]:
    """Blurred cover-scaled background duplicate behind a contained clip.

    Mirrors the canvas `drawCanvasFill`: take the (cropped) source, scale it to
    *cover* the whole frame (× an extra factor so blurred edges bleed past it),
    centre-crop to the frame, blur, darken to 0.82 brightness, and overlay it
    full-frame for the clip's lifetime. The contained clip is drawn on top by the
    caller. Returns ([], prev) when the clip has no blur canvas fill.
    """
    cf = clip.get("canvasFill") or {}
    if cf.get("mode") != "blur":
        return [], prev

    # blurPx is authored on the 720p preview canvas; scale to this resolution so
    # the blur strength RELATIVE to the frame matches what the user tuned.
    blur = max(1.0, min(80.0, _finite_float(cf.get("blurPx"), 34))) * h / 720.0
    extra = max(1.0, _finite_float(cf.get("scale"), 1.08))
    opacity = max(0.0, min(1.0, _finite_float(cf.get("opacity"), 1.0))) * float(
        clip.get("opacity", 1) or 1
    )
    start = float(clip.get("startSec", 0) or 0)
    end = start + _eff_dur(clip)
    speed = max(0.01, float(clip.get("speed", 1) or 1))
    is_image = clip.get("kind") == "image"

    chain: list[str] = []
    # Rebase PTS the same way _visual_chain does (so frame selection matches the
    # foreground), applying speed for video.
    chain.append("setpts=PTS-STARTPTS" if is_image else f"setpts=(PTS-STARTPTS)/{speed:.5f}")

    # Crop first (mirror the foreground crop), then cover-scale + centre-crop.
    t = clip.get("transform", {}) or {}
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

    # Cheap blur: blur at a downscaled resolution, then upscale to the frame. A
    # full-frame blur every frame is the single biggest CPU cost of a blurred
    # background; blurring ~1/4 size is ~16x fewer pixels and the upscale itself
    # smooths it, so the result looks the same. cover→crop is done at the small
    # size; the sigma scales down with the resolution, then the final upscale
    # (≈1/ds) brings the effective radius back to `blur`.
    #
    # gblur (Gaussian), not boxblur: the canvas renderers use CSS `blur(N)`,
    # which is a Gaussian with σ=N — a single-pass boxblur of the same radius is
    # both weaker (σ≈r/√3) and visibly streakier, so the burned background never
    # matched the preview.
    long_edge = max(w, h)
    ds = min(1.0, 480.0 / long_edge) if long_edge > 0 else 1.0
    sw = max(2, round(w * ds))
    sh = max(2, round(h * ds))
    sigma_small = max(0.5, blur * ds)
    chain.append(
        f"scale=w='iw*max({sw}/iw\\,{sh}/ih)*{extra:.4f}':h='ih*max({sw}/iw\\,{sh}/ih)*{extra:.4f}'"
    )
    chain.append(f"crop={sw}:{sh}")
    chain.append(f"gblur=sigma={sigma_small:.2f}")
    chain.append(f"scale={w}:{h}")   # upscale to the frame (adds extra smoothing)
    # brightness(0.82): multiply RGB. colorchannelmixer also carries the alpha
    # multiply for opacity (needs an alpha plane).
    if opacity < 0.999:
        chain.append("format=yuva420p")
        chain.append(f"colorchannelmixer=rr=0.82:gg=0.82:bb=0.82:aa={opacity:.3f}")
    else:
        chain.append("colorchannelmixer=rr=0.82:gg=0.82:bb=0.82")
    chain.append(f"setpts=PTS+{start:.4f}/TB")

    bg = f"cfbg{idx}"
    out = f"cfo{idx}"
    parts = [
        f"[{src}]" + ",".join(chain) + f"[{bg}]",
        f"[{prev}][{bg}]overlay=x=0:y=0:eof_action=pass:"
        f"enable='between(t,{start:.4f},{end:.4f})'[{out}]",
    ]
    return parts, out


def _finite_float(value, fallback: float) -> float:
    try:
        n = float(value)
    except (TypeError, ValueError):
        return fallback
    return n if math.isfinite(n) else fallback


# Look-filter presets — MUST mirror FILTER_PRESETS in src/engine/timeline/types.ts
# so the canvas preview and this FFmpeg grade match.
# (brightness, contrast, saturation %, hue°, sharpen 0..1) at intensity 1.
_FILTER_PRESETS = {
    "4k": (4, 20, 24, 0, 0.8),
    "vivid": (2, 14, 42, 0, 0.3),
    "warm": (3, 10, 20, -10, 0.15),
    "cool": (2, 10, 16, 12, 0.15),
    "cinematic": (-3, 24, -6, -6, 0.25),
    "bw": (4, 24, -100, 0, 0.3),
}


def _filter_fx_filters(prev: str, clip: dict, idx: int) -> tuple[list[str], str]:
    """Full-frame look filter (CapCut-style) applied to the composited stream for
    the clip's lifetime via time-gated `eq` (+ `hue`, + `unsharp` clarity),
    matching the canvas. Returns ([], prev) for a non-filter fx clip."""
    fxd = clip.get("fxData") or {}
    if fxd.get("type") != "filter":
        return [], prev
    base = _FILTER_PRESETS.get(fxd.get("filter"), _FILTER_PRESETS["4k"])
    k = max(0.0, min(1.0, _finite_float(fxd.get("intensity"), 1.0)))
    b, c, s, hue, sharp = base[0] * k, base[1] * k, max(-100.0, base[2] * k), base[3] * k, base[4] * k
    start = float(clip.get("startSec", 0) or 0)
    end = start + _eff_dur(clip)
    gate = f"enable='between(t,{start:.4f},{end:.4f})'"
    chain = ",".join(_adjust_filters(b, c, s, gate)) or "null"
    if abs(hue) > 0.5:
        chain += f",hue=h={hue:.2f}:{gate}"
    if sharp > 0.001:
        # The "4K/HD" clarity: a 5x5 unsharp mask. luma_amount ~ sharpen*1.5.
        chain += f",unsharp=5:5:{sharp * 1.5:.3f}:5:5:0:{gate}"
    out = f"flt{idx}"
    return [f"[{prev}]{chain}[{out}]"], out


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

    # blurPx is authored on the 720p preview — scale to this resolution (same
    # convention as the canvas fill), so sticker blur strength matches the preview.
    requested_blur = max(0, min(80, int(round(_finite_float(fx.get("blurPx"), 18)))))
    requested_blur = max(0, int(round(requested_blur * h / 720.0)))
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
            # gblur to match the canvas CSS Gaussian blur(σ=N) — see _canvas_fill_filters.
            f"gblur=sigma={blur},"
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
    if abs(speed - 1) > 1e-6 and clip.get("trackKind") == "audio":
        # WebAudio AudioBufferSourceNode playbackRate (used by Preview for
        # audio tracks) changes pitch with speed. Match that path; video-track
        # media elements preserve pitch and continue to use atempo below.
        parts.extend([
            "aresample=48000",
            f"asetrate={48000 * speed:.3f}",
            "aresample=48000",
        ])
    else:
        tempo = _atempo_chain(speed)
        if tempo:
            parts.append(tempo.rstrip(","))
    # Preview routes source -> gain -> denoise worklet. Keep the same ordering
    # so a clip gain change moves the signal against the configured noise floor
    # identically, even though FFmpeg uses afftdn for the server implementation.
    parts.append(f"volume={vol:.3f}")
    denoise = clip.get("denoise")
    if denoise in _DENOISE_NF:
        parts.append(f"afftdn=nf={_DENOISE_NF[denoise]}")
    output_duration = max(0.0, _eff_dur(clip))
    fade_in = min(
        output_duration,
        max(0.0, float(
            clip.get("_seamFadeInSec", 0) or clip.get("audioFadeInSec", 0) or 0
        )),
    )
    fade_out = min(
        output_duration,
        max(0.0, float(
            clip.get("_seamFadeOutSec", 0) or clip.get("audioFadeOutSec", 0) or 0
        )),
    )
    if fade_in > 0:
        parts.append(f"afade=t=in:st=0:d={fade_in:.6f}")
    if fade_out > 0:
        parts.append(
            f"afade=t=out:st={max(0.0, output_duration - fade_out):.6f}:"
            f"d={fade_out:.6f}"
        )
    parts.append(f"adelay={start_ms}:all=1")
    return f"[{src}]" + ",".join(parts) + f"[{label}]"


def _mix_audio_buses(
    _clips: list[dict], labels: list[str], duration: float, out_label: str
) -> list[str]:
    """Mix the audible editor clips without changing their relative levels."""
    if not labels:
        return []
    if len(labels) == 1:
        return [f"[{labels[0]}]anull[{out_label}]"]
    # Keep amix alive for the whole timeline. With delayed inputs, FFmpeg can
    # otherwise end the mix when the early inputs reach EOF before the latest
    # input starts. That made exports go silent after detaching audio from an
    # early split segment even though the later video segments remained audible.
    # normalize=0 means this silent anchor does not change any clip's level.
    pads = "".join(f"[{label}]" for label in labels)
    return [
        f"anullsrc=r=48000:cl=stereo,atrim=duration={duration:.6f}[mixanchor]",
        f"[mixanchor]{pads}amix=inputs={len(labels) + 1}:"
        f"normalize=0:dropout_transition=0[{out_label}]",
    ]


def _audible_clips(spec: dict, asset_paths: dict[str, str]) -> list[dict]:
    """Return the timeline media clips that contribute to the final audio mix.

    Kept separate from :func:`build_command` so Hybrid Export can reuse the
    exact same mute/hidden/source-probe rules without running the server visual
    compositor. Contiguous scene-split runs are collapsed first; this is both
    exact for untouched cuts and critical for multi-hour sources.
    """
    tracks = spec.get("tracks", [])
    muted_track = {t.get("id"): bool(t.get("muted")) for t in tracks}
    hidden_tracks = {t.get("id") for t in tracks if t.get("hidden")}
    clips = [
        c for c in spec.get("clips", [])
        if c.get("trackId") not in hidden_tracks
    ]
    clips = _merge_contiguous_runs(clips)
    return [
        c for c in clips
        if c.get("kind") in ("video", "audio")
        and c.get("assetId")
        and not c.get("muted")
        and not muted_track.get(c.get("trackId"), False)
        and float(c.get("volume", 1) or 0) > 0
        and (
            c.get("hasAudio")
            or _has_audio_stream(asset_paths.get(c.get("assetId") or "", ""))
        )
    ]


def _hybrid_audio_inputs_and_graph(
    spec: dict,
    asset_paths: dict[str, str],
    *,
    input_index_offset: int = 0,
) -> tuple[list[list[str]], str, int]:
    """Build seek-bounded audio inputs and a timeline-positioned mix graph."""
    duration = float(spec["durationSec"])
    audio = _audible_clips(spec, asset_paths)
    inputs: list[list[str]] = []
    parts: list[str] = []
    mixed_clips: list[dict] = []
    for idx, clip in enumerate(audio):
        path = asset_paths.get(clip.get("assetId") or "")
        if not path:
            continue
        in_pt = float(clip.get("inPointSec", 0) or 0)
        win = max(0.0, float(clip.get("outPointSec", 0) or 0) - in_pt)
        if win <= 1e-9:
            continue
        seek = ["-ss", f"{in_pt:.6f}"] if in_pt > 1e-6 else []
        inputs.append([*seek, "-t", f"{win:.6f}", "-i", path])
        mixed_clips.append(clip)
        src = f"{input_index_offset + len(inputs) - 1}:a"
        parts.append(_audio_chain(clip, src, f"ha{len(inputs) - 1}"))

    count = len(inputs)
    if count == 0:
        return inputs, f"anullsrc=r=48000:cl=stereo:d={duration:.6f}[haout]", count
    parts.extend(_mix_audio_buses(
        mixed_clips, [f"ha{i}" for i in range(count)], duration, "hamix"
    ))
    # Every chunk/file has exactly the requested timeline duration. Padding PCM
    # here prevents a late silent tail from shortening audio and keeps chunk
    # boundaries sample-stable before the single final AAC encode.
    final_filters = [
        f"apad=whole_dur={duration:.6f}",
        f"atrim=duration={duration:.6f}",
    ]
    mastering = audio_mastering_filter(spec)
    if mastering:
        final_filters.append(mastering)
    parts.append(f"[hamix]{','.join(final_filters)}[haout]")
    return inputs, ";".join(parts), count


def _append_filtergraph(
    cmd: list[str], graph: str, work_dir: str, basename: str
) -> list[str]:
    """Append a filter graph inline or through a Windows-safe script file."""
    assembled = sum(len(a) for a in cmd) + len(graph)
    if assembled > _FILTERGRAPH_SCRIPT_THRESHOLD:
        graph_name = basename
        with open(os.path.join(work_dir, graph_name), "w", encoding="utf-8") as f:
            f.write(graph)
        cmd += ["-filter_complex_script", graph_name]
    else:
        cmd += ["-filter_complex", graph]
    return cmd


def build_hybrid_audio_pcm_command(
    spec: dict, asset_paths: dict[str, str], out_path: str, work_dir: str
) -> list[str]:
    """Mix one time-sliced Hybrid Export audio chunk to PCM in a NUT container."""
    duration = float(spec["durationSec"])
    inputs, graph, count = _hybrid_audio_inputs_and_graph(spec, asset_paths)
    if count > _MAX_GENERAL_INPUTS:
        raise ValueError(
            f"Hybrid audio chunk requires {count} FFmpeg inputs; safe limit is "
            f"{_MAX_GENERAL_INPUTS}. Reduce simultaneous audio layers."
        )
    cfg_threads = get_settings().export_threads
    n_threads = cfg_threads if cfg_threads > 0 else max(1, (os.cpu_count() or 4) - 2)
    parallel_chunks = max(1, int(spec.get("_parallelChunks", 1) or 1))
    n_threads = max(1, n_threads // parallel_chunks)
    cmd = [
        "ffmpeg", "-hide_banner", "-y",
        "-filter_complex_threads", str(n_threads),
        "-filter_threads", str(n_threads),
    ]
    for inp in inputs:
        cmd += inp
    _append_filtergraph(cmd, graph, work_dir, "hybrid-audio-filtergraph.txt")
    cmd += [
        "-map", "[haout]", "-c:a", "pcm_s16le", "-ac", "2", "-ar", "48000",
        "-t", f"{duration:.6f}", "-f", "nut", out_path,
    ]
    return cmd


def build_hybrid_audio_mux_command(
    spec: dict,
    asset_paths: dict[str, str],
    browser_video_path: str,
    out_path: str,
    work_dir: str,
) -> list[str]:
    """Copy Browser-rendered pixels and add the server-side timeline audio mix.

    Video is always ``-c:v copy``: the backend never decodes or re-encodes the
    Browser visual track, so the final MP4 remains pixel-identical to preview.
    """
    duration = float(spec["durationSec"])
    audio_bitrate_kbps = max(
        64, min(512, int(spec.get("audioBitrateKbps", 192)))
    )
    inputs, graph, count = _hybrid_audio_inputs_and_graph(
        spec, asset_paths, input_index_offset=1
    )
    if count > _MAX_GENERAL_INPUTS:
        raise ValueError(
            f"Hybrid audio requires {count} FFmpeg inputs; safe limit is "
            f"{_MAX_GENERAL_INPUTS}. Use chunked Hybrid audio."
        )
    cfg_threads = get_settings().export_threads
    n_threads = cfg_threads if cfg_threads > 0 else max(1, (os.cpu_count() or 4) - 2)
    cmd = [
        "ffmpeg", "-hide_banner", "-y",
        "-filter_complex_threads", str(n_threads),
        "-filter_threads", str(n_threads),
        "-i", browser_video_path,
    ]
    for inp in inputs:
        cmd += inp
    _append_filtergraph(cmd, graph, work_dir, "hybrid-audio-filtergraph.txt")
    cmd += [
        "-map", "0:v:0", "-map", "[haout]",
        "-c:v", "copy",
        "-c:a", "aac", "-b:a", f"{audio_bitrate_kbps}k",
        "-ac", "2", "-ar", "48000",
        "-t", f"{duration:.6f}", "-movflags", "+faststart", out_path,
    ]
    return cmd


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
    work_dir: str, font_map: dict | None = None,
    quality_profile: str = "balanced", audio_bitrate_kbps: int = 192,
    audio_mastering: str = "off",
    video_codec: str = "h264", dynamic_range: str = "sdr",
) -> list[str] | None:
    """Direct-transcode command for the most common export: ONE untouched video
    clip covering the whole timeline (trim-and-export), optionally with burned
    captions. Returns None when the timeline needs real compositing.

    The general path drags every frame through a CPU filtergraph
    (black background → scale → overlay → format) even when nothing is
    composited, which caps a hardware-encoded export at filtergraph speed.
    Skipping the graph entirely lets the decoder (NVDEC et al.) feed the
    encoder almost directly — several times faster, and what dedicated editors
    do for simple timelines. Captions are burned via a single `ass` video
    filter (libass) instead of the full overlay graph.
    """
    if len(visual) != 1:
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

    # Lossless smart-render for a genuinely untouched full source. Stream-copy
    # is deliberately strict: an in-point trim is not keyframe-exact with
    # `-c copy`, a 29.97->30 request would violate the chosen output FPS, and a
    # rotated stream needs display-matrix handling. Anything ambiguous stays on
    # the existing frame-accurate transcode path.
    source_duration = float(meta.get("durationSec") or 0)
    source_fps = float(meta.get("fps") or 0)
    in_pt = float(c.get("inPointSec", 0) or 0)
    out_pt = float(c.get("outPointSec", 0) or 0)
    # Less than a quarter frame: enough for container time-base rounding, but
    # too small to silently accept an actual end trim and return extra frames.
    duration_tolerance = max(0.005, 0.25 / max(1, fps))
    source_audio_codec = str(meta.get("audioCodec") or "")
    source_codec = str(meta.get("videoCodec") or "")
    source_is_hdr10 = _is_hdr10_meta(meta)
    source_is_hdr = _is_hdr_meta(meta)
    if dynamic_range == "hdr10":
        if video_codec not in {"hevc", "av1"}:
            raise ValueError("HDR10 export requires HEVC or AV1")
        if text:
            raise ValueError(
                "HDR10 currently requires an overlay-free single-source timeline; "
                "caption/effect compositing is still an 8-bit path"
            )
        if not source_is_hdr10:
            raise ValueError(
                "HDR10 requires a 10-bit BT.2020/PQ source; use SDR for this media"
            )

    can_copy_video = (
        not text
        and str(audio_mastering or "off") == "off"
        and in_pt <= 1e-6
        and source_duration > 0
        and abs(source_duration - duration) <= duration_tolerance
        and abs(out_pt - source_duration) <= duration_tolerance
        and source_fps > 0
        and abs(source_fps - fps) <= 1e-3
        and (sw, sh) == (w, h)
        and source_codec == video_codec
        and (
            source_is_hdr10 if dynamic_range == "hdr10"
            else str(meta.get("pixFmt") or "") in {"yuv420p", "yuvj420p"}
        )
        and str(meta.get("sampleAspectRatio") or "") == "1:1"
        and abs(float(meta.get("rotation") or 0)) <= 1e-3
        and (not want_audio or bool(source_audio_codec))
    )
    if can_copy_video:
        logging.getLogger(__name__).info(
            "Export smart path: untouched %s source -> stream copy", video_codec
        )
        cmd = [
            "ffmpeg", "-hide_banner", "-y", "-i", path,
            "-map", "0:v:0", "-c:v", "copy",
        ]
        if want_audio:
            cmd += ["-map", "0:a:0"]
            source_audio_is_output_compatible = (
                source_audio_codec == "aac"
                and 0 < int(meta.get("audioChannels") or 0) <= 2
                and int(meta.get("audioSampleRate") or 0) == 48000
            )
            if source_audio_is_output_compatible:
                cmd += ["-c:a", "copy"]
            else:
                cmd += [
                    "-c:a", "aac", "-b:a", f"{audio_bitrate_kbps}k",
                    "-ac", "2", "-ar", "48000",
                ]
        else:
            cmd += ["-an"]
        cmd += ["-movflags", "+faststart", out_path]
        return cmd

    encoder = (
        detect_hdr10_encoder(video_codec)
        if dynamic_range == "hdr10"
        else detect_video_encoder(video_codec)
    )
    if encoder is None:
        raise ValueError(
            f"HDR10 requires a working 10-bit {video_codec.upper()} encoder; "
            "none passed the capability probe"
        )
    needs_scale = (sw, sh) != (w, h)
    # GPU decode via the cuvid decoder, which `-resize` lets scale during decode.
    # This is what makes a 4K (esp. AV1) export fast: `-hwaccel auto` would decode
    # AV1 in software (libaom, ~2x realtime) — the dominant cost of the export.
    dec = cuvid_decoder_for(path, encoder)
    # Captions force a CPU video filter (libass ass=), so GPU-side -resize can't
    # be used — fold the scale into the same -vf chain instead.
    has_text = bool(text)
    use_gpu_resize = bool(dec and needs_scale and not has_text)
    logging.getLogger(__name__).info(
        "Export fast path: single full-frame clip%s → direct transcode (%s%s)",
        " + captions" if has_text else "", encoder, f", {dec}" if dec else "",
    )
    cmd: list[str] = ["ffmpeg", "-hide_banner", "-y"]
    if dec:
        cmd += ["-c:v", dec]
        if use_gpu_resize:
            cmd += ["-resize", f"{w}x{h}"]  # GPU-side scale during decode
    elif not encoder.startswith("lib") and not source_is_hdr:
        cmd += ["-hwaccel", "auto"]  # HW decode; silent SW fallback per input
    if in_pt > 1e-3:
        # Input seeking: jumps to the nearest prior keyframe then decodes up to
        # the exact point — fast AND frame-accurate for a re-encode.
        cmd += ["-ss", f"{in_pt:.4f}"]
    cmd += ["-i", path]
    # Build the (CPU) -vf chain: scale when the GPU decoder didn't already, plus
    # the ass caption burn. The ass file is referenced by basename and the job
    # runs with cwd=work_dir (same convention as the general path).
    vf: list[str] = []
    if dynamic_range == "sdr" and _is_hdr_meta(meta):
        vf.append(_HDR_TO_SDR_FILTER)
    if needs_scale and not use_gpu_resize:
        vf.append(f"scale={w}:{h}")
    if has_text:
        ass_name = "captions.ass"
        with open(os.path.join(work_dir, ass_name), "w", encoding="utf-8") as f:
            f.write(build_ass(w, h, [_ass_clip(t) for t in text], font_map))
        vf.append(_ass_vf(work_dir, ass_name))
    if vf:
        cmd += ["-vf", ",".join(vf)]
    cfg_threads = get_settings().export_threads
    n_threads = cfg_threads if cfg_threads > 0 else max(1, (os.cpu_count() or 4) - 2)
    cmd += export_video_quality_args(
        encoder, quality_profile, kbps, n_threads
    )
    if dynamic_range == "hdr10":
        cmd += hdr_metadata_args(encoder, meta)
    if codec_family_for_encoder(encoder) == "hevc":
        cmd += ["-tag:v", "hvc1"]
    cmd += [*output_color_args(encoder, dynamic_range), "-r", str(fps), "-t", f"{duration:.4f}"]
    if want_audio:
        mastering = audio_mastering_filter({"audioMastering": audio_mastering})
        if mastering:
            cmd += ["-af", mastering]
        cmd += [
            "-c:a", "aac", "-b:a", f"{audio_bitrate_kbps}k", "-ac", "2"
        ]
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
    for key in ("audioFadeInSec", "audioFadeOutSec", "intentionalOverlap"):
        if (a.get(key) or None) != (b.get(key) or None):
            return False
    if (a.get("transform") or {}) != (b.get("transform") or {}):
        return False
    if (a.get("adjust") or {}) != (b.get("adjust") or {}):
        return False
    if (a.get("canvasFill") or None) != (b.get("canvasFill") or None):
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
    quality_profile = str(spec.get("qualityProfile") or "balanced")
    audio_bitrate_kbps = max(64, min(512, int(spec.get("audioBitrateKbps", 192))))
    audio_mastering = str(spec.get("audioMastering") or "off")
    video_codec = str(spec.get("videoCodec") or "h264")
    if video_codec not in {"h264", "hevc", "av1"}:
        video_codec = "h264"
    dynamic_range = str(spec.get("dynamicRange") or "sdr")
    if dynamic_range not in {"sdr", "hdr10"}:
        dynamic_range = "sdr"

    tracks = spec.get("tracks", [])
    track_index = {t["id"]: i for i, t in enumerate(tracks)}
    muted_track = {t["id"]: bool(t.get("muted")) for t in tracks}
    hidden_tracks = {t["id"] for t in tracks if t.get("hidden")}

    # Hidden tracks are excluded from the export entirely (what you see in the
    # preview is what you get) — drop their clips before anything else.
    spec_clips = [c for c in spec.get("clips", []) if c.get("trackId") not in hidden_tracks]
    if "_chunkStartSec" in spec:
        chunk_start = float(spec["_chunkStartSec"])
        chunk_end = float(spec.get("_chunkEndSec", chunk_start + duration))
        spec_clips = _slice_clips_for_chunk(
            spec_clips,
            chunk_start,
            chunk_end,
            seam_fade_in_sec=max(
                0, float(spec.get("_seamAudioFadeInSec", 0) or 0)
            ),
            seam_fade_out_sec=max(
                0, float(spec.get("_seamAudioFadeOutSec", 0) or 0)
            ),
        )
    # Collapse scene-split runs back into whole clips before anything else — this
    # is what keeps "split then export" from building a filtergraph so deep it
    # OOMs ffmpeg (esp. with burned captions on top).
    clips = _merge_contiguous_runs(spec_clips)
    visual = [c for c in clips if c.get("kind") in ("video", "image")]
    # Bottom track (higher index) drawn first; top track (lower index) ends on top.
    visual.sort(key=lambda c: (-track_index.get(c["trackId"], 0), float(c["startSec"])))
    fx = [
        c for c in clips
        if c.get("kind") == "fx"
        and (c.get("fxData") or {}).get("type") in ("blur-sticker", "filter")
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

    # Simple trim-and-export timelines (single full-frame clip, optionally with
    # captions) skip the compositing graph entirely.
    font_map = _caption_font_map(spec)
    if not fx and not spec.get("_disableFastPath"):
        fast = _fast_single_clip_command(
            visual, audio, text, asset_paths, w, h, fps, duration, kbps, out_path, work_dir,
            font_map, quality_profile, audio_bitrate_kbps, audio_mastering,
            video_codec, dynamic_range,
        )
        if fast is not None:
            return fast

    if dynamic_range == "hdr10":
        raise ValueError(
            "HDR10 compositing is not enabled yet because the general FFmpeg graph "
            "uses an 8-bit base. Use an overlay-free single HDR source or export SDR."
        )

    # General compositing has an 8-bit Rec.709 base. Detect each unique HDR10
    # input once so it can be tone-mapped before blur/scale/overlay instead of
    # clipping PQ code values or retaining HDR metadata on an SDR file.
    hdr10_paths: set[str] = set()
    probed_hdr: dict[str, bool] = {}
    if dynamic_range == "sdr":
        from ..ffmpeg_utils import probe
        for clip in visual:
            if clip.get("kind") != "video":
                continue
            source_path = asset_paths.get(clip.get("assetId") or "")
            if not source_path:
                continue
            if source_path not in probed_hdr:
                try:
                    probed_hdr[source_path] = _is_hdr_meta(probe(source_path))
                except Exception:
                    probed_hdr[source_path] = False
            if probed_hdr[source_path]:
                hdr10_paths.add(source_path)

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
    encoder = detect_video_encoder(video_codec)

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
        # Blurred canvas-fill background runs the decoded frame through
        # `boxblur` (_canvas_fill_filters). On this ffmpeg build, `boxblur` fed a
        # hardware-decoded frame (cuvid OR -hwaccel auto/DXVA2) corrupts part of
        # the frame solid green — reproduced directly against this filter chain;
        # plain software-decoded frames are unaffected. Force software decode for
        # just these inputs rather than disabling HW decode timeline-wide.
        has_blur_fill = (c.get("canvasFill") or {}).get("mode") == "blur"
        if use_hw_decode and not has_blur_fill and path not in hdr10_paths:
            dec = cuvid_decoder_for(path, encoder)
            if dec:
                pre = ["-c:v", dec]                       # forced GPU decoder
            elif not encoder.startswith("lib"):
                pre = ["-hwaccel", "auto"]                # generic HW decode + SW fallback
        seek = ["-ss", f"{in_pt:.4f}"] if in_pt > 1e-3 else []
        inputs.append([*pre, *seek, "-t", f"{win:.4f}", "-i", path])

    if len(inputs) > _MAX_GENERAL_INPUTS:
        raise ValueError(
            f"Timeline requires {len(inputs)} independent FFmpeg inputs; safe limit is "
            f"{_MAX_GENERAL_INPUTS}. Merge contiguous clips/remove per-clip effects, "
            "or use browser export."
        )

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
        src = vsrc[c["id"]]
        source_path = asset_paths.get(c.get("assetId") or "")
        if source_path in hdr10_paths:
            tone_mapped = f"hdrsdr{vn}"
            parts.append(f"[{src}]{_HDR_TO_SDR_FILTER}[{tone_mapped}]")
            src = tone_mapped
        # Blurred canvas-fill background: split the source so one copy fills the
        # frame (blurred) behind the contained foreground copy.
        if (c.get("canvasFill") or {}).get("mode") == "blur":
            fg_src = f"cffg{vn}"
            bg_src = f"cfsrc{vn}"
            parts.append(f"[{src}]split=2[{fg_src}][{bg_src}]")
            bg_parts, prev = _canvas_fill_filters(prev, c, bg_src, w, h, vn)
            parts.extend(bg_parts)
            src = fg_src
        lbl = f"v{vn}"
        parts.append(_visual_chain(c, src, w, h, lbl))
        start = float(c["startSec"])
        end = start + _eff_dur(c)
        t = c.get("transform", {}) or {}
        # Position: keyframed x/y become time-varying overlay expressions. The
        # overlay's `t` is timeline seconds, so the keyframe expr (clip-local)
        # reads `(t-start)`.
        xk, yk = _kf_track(c, "x"), _kf_track(c, "y")
        loc = _animation_time(c, f"(t-{start:.4f})")
        tx_expr = _kf_value_expr(xk, loc) if xk else f"{float(t.get('x', 0.5)):.4f}"
        ty_expr = _kf_value_expr(yk, loc) if yk else f"{float(t.get('y', 0.5)):.4f}"
        out_lbl = f"ov{vn}"
        parts.append(
            f"[{prev}][{lbl}]overlay=x='(W*({tx_expr}))-(w/2)':y='(H*({ty_expr}))-(h/2)'"
            f":eof_action=pass:enable='between(t,{start:.4f},{end:.4f})'[{out_lbl}]"
        )
        prev = out_lbl
        vn += 1

    fn = 0
    for c in fx:
        if (c.get("fxData") or {}).get("type") == "filter":
            generated, out_lbl = _filter_fx_filters(prev, c, fn)
        else:
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
            f.write(build_ass(w, h, [_ass_clip(c) for c in text], font_map))
        parts.append(f"[{visual_out}]{_ass_vf(work_dir, ass_name)}[vout]")
        vmap = "[vout]"
    else:
        # Ensure a named, encodable output even with no overlays.
        parts.append(f"[{visual_out}]format=yuv420p[vout]")
        vmap = "[vout]"

    # Audio — same one-input-per-clip story; read each clip's seeked audio pad.
    asrc = {c["id"]: f"{clip_input[c['id']]}:a" for c in audio if c["id"] in clip_input}

    amap = None
    mixed_audio_label = "apremaster"
    an = 0
    mixed_audio_clips: list[dict] = []
    for c in audio:
        if c["id"] not in clip_input:
            continue
        parts.append(_audio_chain(c, asrc[c["id"]], f"a{an}"))
        mixed_audio_clips.append(c)
        an += 1
    if an > 0:
        parts.extend(_mix_audio_buses(
            mixed_audio_clips,
            [f"a{i}" for i in range(an)],
            duration,
            mixed_audio_label,
        ))
        amap = f"[{mixed_audio_label}]"
    elif spec.get("_forceAudioStream"):
        parts.append(
            f"anullsrc=r=48000:cl=stereo:d={duration:.4f}[{mixed_audio_label}]"
        )
        amap = f"[{mixed_audio_label}]"

    if amap:
        # A chunk may contain real audio only near its beginning or end.  Without
        # an exact-duration audio pad, FFmpeg writes a shorter audio stream than
        # the video stream; the concat demuxer then appends the next chunk's audio
        # at the wrong timestamp, which sounds like a missing section.  Keep every
        # regular export (and especially every chunk intermediate) sample-aligned
        # with the requested timeline duration, matching the Hybrid audio path.
        parts.append(
            f"{amap}apad=whole_dur={duration:.6f},"
            f"atrim=duration={duration:.6f}[atimeline]"
        )
        amap = "[atimeline]"

    mastering = "" if spec.get("_chunkIntermediate") else audio_mastering_filter(spec)
    if amap and mastering:
        parts.append(f"{amap}{mastering}[aout]")
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
    parallel_chunks = max(1, int(spec.get("_parallelChunks", 1) or 1))
    n_threads = max(1, n_threads // parallel_chunks)

    cmd: list[str] = ["ffmpeg", "-hide_banner", "-y"]
    # Cap the filtergraph worker threads (the main CPU consumer here).
    cmd += ["-filter_complex_threads", str(n_threads),
            "-filter_threads", str(n_threads)]
    # HW decode is selected PER INPUT above (forced cuvid decoder where the codec
    # supports it, else -hwaccel auto) — decoded frames are downloaded to system
    # memory for the CPU filtergraph.
    for inp in inputs:
        cmd += inp

    # Keep the filtergraph inline for normal timelines; spill it to a side file
    # (referenced by basename, read relative to cwd=work_dir like the ASS file)
    # only when the assembled command would approach the OS command-line limit —
    # the dense scene-split case that hit WinError 206. See the threshold note.
    assembled = sum(len(a) for a in cmd) + len(graph)
    if assembled > _FILTERGRAPH_SCRIPT_THRESHOLD:
        graph_name = "filtergraph.txt"
        with open(os.path.join(work_dir, graph_name), "w", encoding="utf-8") as f:
            f.write(graph)
        cmd += ["-filter_complex_script", graph_name]
    else:
        cmd += ["-filter_complex", graph]
    cmd += ["-map", vmap]
    if amap:
        cmd += ["-map", amap]

    cmd += export_video_quality_args(
        encoder, quality_profile, kbps, n_threads
    )
    if codec_family_for_encoder(encoder) == "hevc":
        cmd += ["-tag:v", "hvc1"]
    cmd += [*output_color_args(encoder, dynamic_range), "-r", str(fps), "-t", f"{duration:.4f}"]

    if amap:
        if spec.get("_chunkIntermediate"):
            # Keep chunk boundaries sample-accurate. Encoding AAC independently
            # per chunk adds encoder priming at every join (audible gaps/clicks);
            # the concat stage encodes this PCM stream to AAC exactly once.
            cmd += ["-c:a", "pcm_s16le", "-ac", "2", "-ar", "48000"]
        else:
            cmd += [
                "-c:a", "aac", "-b:a", f"{audio_bitrate_kbps}k",
                "-ac", "2", "-ar", "48000",
            ]

    if not spec.get("_chunkIntermediate"):
        cmd += ["-movflags", "+faststart"]
    cmd += [out_path]
    command_chars = len(subprocess.list2cmdline(cmd))
    if command_chars > _MAX_COMMAND_CHARS:
        raise ValueError(
            f"FFmpeg command is too large for safe Windows launch ({command_chars} chars; "
            f"limit {_MAX_COMMAND_CHARS}). Shorten the work/output path or reduce "
            "independent clips."
        )
    return cmd
