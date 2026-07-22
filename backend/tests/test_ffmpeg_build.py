"""Unit tests for the FFmpeg command builder (pure-logic parts)."""
from __future__ import annotations

import inspect
import shutil
import subprocess
from unittest.mock import patch

import pytest

from app.export import ffmpeg_build as fb


# ── _atempo_chain ───────────────────────────────────────────────────────────

def test_atempo_identity_is_empty():
    assert fb._atempo_chain(1.0) == ""


def test_atempo_in_range_single_factor():
    # 1.5 is within atempo's 0.5–2.0 range → one factor.
    out = fb._atempo_chain(1.5)
    assert out == "atempo=1.5000,"


def test_atempo_above_2_chains_factors():
    # 4.0 needs 2.0 * 2.0 → two chained atempo filters.
    out = fb._atempo_chain(4.0)
    assert out.count("atempo=") == 2
    assert out.startswith("atempo=2.0000,")


def test_atempo_below_half_chains_factors():
    # 0.25 needs 0.5 * 0.5 → two factors.
    out = fb._atempo_chain(0.25)
    assert out.count("atempo=") == 2
    assert "atempo=0.5000," in out


# ── _eff_dur ────────────────────────────────────────────────────────────────

def test_eff_dur_plain():
    assert fb._eff_dur({"inPointSec": 0, "outPointSec": 6, "speed": 1}) == 6.0


def test_eff_dur_speed_halves_duration():
    assert fb._eff_dur({"inPointSec": 0, "outPointSec": 6, "speed": 2}) == 3.0


def test_hybrid_mux_stream_copies_browser_video_and_mixes_audio(tmp_path):
    spec = {
        "durationSec": 5,
        "tracks": [{"id": "v", "muted": False}],
        "clips": [{
            **_BASE_CLIP,
            "trackId": "v",
            "hasAudio": True,
            "volume": 0.75,
        }],
    }
    cmd = fb.build_hybrid_audio_mux_command(
        spec,
        {"a": "/source.mp4"},
        "/browser-video.mp4",
        "/final.mp4",
        str(tmp_path),
    )

    assert cmd[cmd.index("-c:v") + 1] == "copy"
    assert "libx264" not in cmd and "h264_nvenc" not in cmd
    assert "0:v:0" in cmd and "[haout]" in cmd
    graph = cmd[cmd.index("-filter_complex") + 1]
    assert "[1:a]" in graph
    assert "volume=0.750" in graph
    assert "apad=whole_dur=5.000000" in graph


def test_hybrid_pcm_silence_has_exact_chunk_duration(tmp_path):
    cmd = fb.build_hybrid_audio_pcm_command(
        {"durationSec": 12.5, "tracks": [], "clips": []},
        {},
        str(tmp_path / "silence.nut"),
        str(tmp_path),
    )
    graph = cmd[cmd.index("-filter_complex") + 1]
    assert "anullsrc=r=48000:cl=stereo:d=12.500000" in graph
    assert cmd[cmd.index("-c:a") + 1] == "pcm_s16le"
    assert cmd[cmd.index("-f") + 1] == "nut"


def test_hybrid_audio_speed_matches_preview_track_playback_contract(tmp_path):
    def graph_for(track_kind: str) -> str:
        spec = {
            "durationSec": 2,
            "tracks": [{"id": "a", "muted": False}],
            "clips": [{
                **_BASE_CLIP, "trackId": "a", "trackKind": track_kind,
                "speed": 2, "outPointSec": 4, "volume": 1, "hasAudio": True,
            }],
        }
        cmd = fb.build_hybrid_audio_pcm_command(
            spec, {"a": "/source.wav"}, str(tmp_path / f"{track_kind}.nut"), str(tmp_path),
        )
        return cmd[cmd.index("-filter_complex") + 1]

    audio_graph = graph_for("audio")
    video_graph = graph_for("video")
    assert "asetrate=96000.000" in audio_graph
    assert "atempo=2.0000" not in audio_graph
    assert "atempo=2.0000" in video_graph


def test_audio_chain_applies_gain_before_denoise():
    graph = fb._audio_chain({
        **_BASE_CLIP,
        "volume": 0.25,
        "denoise": "medium",
    }, "0:a", "a0")

    assert graph.index("volume=0.250") < graph.index("afftdn=nf=-25")


def test_hybrid_seam_fade_is_per_clip_not_whole_mix(tmp_path):
    spec = {
        "durationSec": 1,
        "tracks": [{"id": "a", "kind": "audio", "muted": False}],
        "clips": [
            {
                **_BASE_CLIP,
                "id": "stateful",
                "assetId": "stateful",
                "trackId": "a",
                "kind": "audio",
                "outPointSec": 1,
                "speed": 2,
                "volume": 1,
                "hasAudio": True,
                "_seamFadeOutSec": 0.005,
            },
            {
                **_BASE_CLIP,
                "id": "bed",
                "assetId": "bed",
                "trackId": "a",
                "kind": "audio",
                "outPointSec": 1,
                "volume": 1,
                "hasAudio": True,
            },
        ],
    }
    cmd = fb.build_hybrid_audio_pcm_command(
        spec,
        {"stateful": "/stateful.wav", "bed": "/bed.wav"},
        str(tmp_path / "audio.nut"),
        str(tmp_path),
    )
    graph = cmd[cmd.index("-filter_complex") + 1]
    stateful = next(part for part in graph.split(";") if part.startswith("[0:a]"))
    bed = next(part for part in graph.split(";") if part.startswith("[1:a]"))
    mix = next(part for part in graph.split(";") if part.startswith("[hamix]"))

    assert "afade=t=out" in stateful
    assert "afade=" not in bed
    assert "afade=" not in mix


# ── proxy_quality_args (per encoder) ────────────────────────────────────────

def test_proxy_args_nvenc_no_crf():
    args = fb.proxy_quality_args("h264_nvenc")
    assert "-crf" not in args            # NVENC rejects -crf
    assert "-cq" in args and "p4" in args


def test_proxy_args_libx264_uses_crf():
    assert fb.proxy_quality_args("libx264") == ["-preset", "veryfast", "-crf", "26"]


def test_proxy_args_qsv_global_quality():
    assert "-global_quality" in fb.proxy_quality_args("h264_qsv")


# ── _visual_chain: alpha only when needed (TASK-06) ─────────────────────────

_BASE_CLIP = {
    "id": "c1", "kind": "video", "assetId": "a", "trackId": "t",
    "inPointSec": 0, "outPointSec": 5, "startSec": 0,
    "speed": 1, "opacity": 1, "effects": [], "transform": {},
}


def test_opaque_clip_has_no_alpha_conversion():
    chain = fb._visual_chain(dict(_BASE_CLIP), 0, 1920, 1080, "v0")
    assert "yuva420p" not in chain


def test_opacity_clip_gets_alpha_and_mixer():
    chain = fb._visual_chain({**_BASE_CLIP, "opacity": 0.5}, 0, 1920, 1080, "v0")
    assert "yuva420p" in chain
    assert "colorchannelmixer" in chain


def test_fade_clip_gets_alpha_and_fade():
    clip = {**_BASE_CLIP, "effects": [{"type": "fade-in", "params": {"duration": 0.5}}]}
    chain = fb._visual_chain(clip, 0, 1920, 1080, "v0")
    assert "yuva420p" in chain
    assert "fade=" in chain


# ── _canvas_fill_filters: blurred cover background ──────────────────────────

def test_canvas_fill_none_is_noop():
    parts, out = fb._canvas_fill_filters("bg", dict(_BASE_CLIP), "0:v", 720, 1280, 0)
    assert parts == [] and out == "bg"


def test_canvas_fill_blur_builds_cheap_downscaled_blur_overlay():
    clip = {**_BASE_CLIP, "canvasFill": {"mode": "blur", "blurPx": 34, "scale": 1.08}}
    parts, out = fb._canvas_fill_filters("bg", clip, "cfsrc0", 720, 1280, 0)
    graph = ";".join(parts)
    assert out == "cfo0"
    # Cheap blur: cover+crop at a downscaled size (ds=480/1280=0.375 → 270x480),
    # a proportionally smaller Gaussian blur, then upscale back to the full
    # frame. gblur (not boxblur) matches the canvas CSS `blur(N)` Gaussian —
    # boxblur at the same radius is both weaker (σ≈r/√3) and visibly streakier.
    assert "crop=270:480" in graph                    # blurred at small size
    # 34 blurPx authored @720p → scaled to output h (34 * 1280/720 ≈ 60.44) →
    # downscaled with the blur pass (× ds=0.375) = 22.67.
    assert "gblur=sigma=22.67" in graph
    assert "scale=720:1280" in graph                  # upscaled to the frame
    assert "colorchannelmixer=rr=0.82" in graph       # brightness(0.82) darken
    assert "overlay=x=0:y=0" in graph and "enable='between(t,0.0000,5.0000)'" in graph


def test_canvas_fill_blur_opacity_adds_alpha():
    clip = {**_BASE_CLIP, "opacity": 0.5,
            "canvasFill": {"mode": "blur", "blurPx": 20, "opacity": 0.5}}
    parts, _ = fb._canvas_fill_filters("bg", clip, "cfsrc0", 720, 1280, 0)
    graph = ";".join(parts)
    assert "yuva420p" in graph
    assert "aa=0.250" in graph                         # 0.5 clip × 0.5 fill opacity


# ── keyframes → time-varying expressions ────────────────────────────────────

def test_kf_value_expr_single_keyframe_is_constant():
    assert fb._kf_value_expr([{"t": 0, "v": 0.5}], "t") == "0.500000"


def test_kf_value_expr_builds_eased_segments():
    expr = fb._kf_value_expr([{"t": 0, "v": 0}, {"t": 2, "v": 1}], "t")
    assert "if(lt(t" in expr                     # piecewise
    assert "(3-2*" in expr                       # smoothstep easing by default
    assert "clip((t-0.000000)/2.000000" in expr  # normalised segment progress


def test_kf_value_expr_linear_segment_has_no_smoothstep():
    expr = fb._kf_value_expr([{"t": 0, "v": 0}, {"t": 1, "v": 1, "ease": "linear"}], "t")
    assert "(3-2*" not in expr


def test_visual_chain_keyframed_scale_is_time_varying():
    clip = {**_BASE_CLIP, "keyframes": {"scale": [{"t": 0, "v": 1}, {"t": 2, "v": 2}]}}
    chain = fb._visual_chain(clip, 0, 1920, 1080, "v0")
    assert "scale=eval=frame" in chain            # per-frame scale, not static


def test_visual_chain_keyframed_rotation_uses_angle_expr():
    clip = {**_BASE_CLIP, "keyframes": {"rotation": [{"t": 0, "v": 0}, {"t": 2, "v": 90}]}}
    chain = fb._visual_chain(clip, 0, 1920, 1080, "v0")
    assert "rotate=a='" in chain and "rotw(" in chain
    assert "format=yuva420p" in chain             # rotation needs transparent corners


# ── look filters (CapCut-style fx) ──────────────────────────────────────────

def test_filter_fx_builds_time_gated_eq():
    clip = {"startSec": 1.0, "inPointSec": 0, "outPointSec": 3, "speed": 1,
            "fxData": {"type": "filter", "filter": "4k", "intensity": 1}}
    parts, out = fb._filter_fx_filters("bg", clip, 0)
    g = ";".join(parts)
    assert out == "flt0"
    # Brightness is now a MULTIPLY via colorchannelmixer (matches CSS brightness()),
    # while contrast/saturation stay on eq= whose 0.5-pivot maths line up with CSS
    # contrast()/saturate(). The old eq=brightness= was an ADDITIVE luma offset
    # that lifted blacks to grey and never matched the preview.
    assert "colorchannelmixer=rr=" in g and "contrast=" in g and "saturation=" in g
    assert "enable='between(t,1.0000,4.0000)'" in g   # gated to [start, start+dur]
    assert "unsharp=5:5:" in g                        # 4K clarity = sharpen pass


def test_filter_fx_intensity_scales_and_bw_desaturates():
    half = fb._filter_fx_filters("bg", {"startSec": 0, "inPointSec": 0, "outPointSec": 2, "speed": 1,
        "fxData": {"type": "filter", "filter": "4k", "intensity": 0.5}}, 0)[0][0]
    assert "saturation=1.120" in half          # 24% * 0.5 → +12%
    bw = fb._filter_fx_filters("bg", {"startSec": 0, "inPointSec": 0, "outPointSec": 2, "speed": 1,
        "fxData": {"type": "filter", "filter": "bw", "intensity": 1}}, 0)[0][0]
    assert "saturation=0.000" in bw            # B&W → fully desaturated


def test_filter_fx_ignored_for_non_filter():
    assert fb._filter_fx_filters("bg", {"fxData": {"type": "blur-sticker"}}, 0) == ([], "bg")


def test_hidden_track_clips_excluded_from_export():
    spec = _single_clip_spec()
    spec["tracks"][0]["hidden"] = True            # hide the only video track
    with patch.object(fb, "detect_video_encoder", return_value="libx264"), \
         patch.object(fb, "cuvid_decoder_for", return_value=None), \
         patch("app.ffmpeg_utils.probe", return_value={"width": 1920, "height": 1080}):
        cmd = fb.build_command(spec, {"A": "/in.mp4"}, "/out.mp4", ".")
    assert "/in.mp4" not in " ".join(cmd)         # hidden track's clip isn't rendered


# ── opacity keyframes: cheap fade vs per-pixel geq ──────────────────────────

def test_opacity_fade_out_uses_fade_filter_not_geq():
    clip = {**_BASE_CLIP, "keyframes": {"opacity": [{"t": 0, "v": 1}, {"t": 2, "v": 0}]}}
    chain = fb._visual_chain(clip, 0, 1920, 1080, "v0")
    assert "fade=t=out:st=0.0000:d=2.0000:alpha=1" in chain
    assert "geq=" not in chain


def test_opacity_fade_in_and_out():
    clip = {**_BASE_CLIP, "keyframes": {"opacity": [
        {"t": 0, "v": 0}, {"t": 1, "v": 1}, {"t": 4, "v": 1}, {"t": 5, "v": 0}]}}
    chain = fb._visual_chain(clip, 0, 1920, 1080, "v0")
    assert "fade=t=in:st=0.0000:d=1.0000:alpha=1" in chain
    assert "fade=t=out:st=4.0000:d=1.0000:alpha=1" in chain
    assert "geq=" not in chain


def test_non_fade_opacity_falls_back_to_geq():
    # dips to 0.5 and back up → not a clean fade → keep the exact per-pixel path
    clip = {**_BASE_CLIP, "keyframes": {"opacity": [
        {"t": 0, "v": 1}, {"t": 1, "v": 0.5}, {"t": 2, "v": 1}]}}
    chain = fb._visual_chain(clip, 0, 1920, 1080, "v0")
    assert "geq=" in chain
    assert "fade=" not in chain


# ── build_command: encoder-specific flags ───────────────────────────────────

_SPEC = {
    "width": 1920, "height": 1080, "fps": 30, "durationSec": 5,
    "videoBitrateKbps": 8000, "tracks": [], "clips": [],
}


def test_build_command_nvenc_adds_balanced_preset_and_rc(tmp_path):
    with patch.object(fb, "detect_video_encoder", return_value="h264_nvenc"):
        cmd = fb.build_command(_SPEC, {}, str(tmp_path / "out.mp4"), str(tmp_path))
    s = " ".join(cmd)
    assert "-c:v h264_nvenc" in s
    assert "-preset p5" in s and "-rc vbr" in s


def test_export_quality_profiles_tune_all_encoder_families():
    assert "p3" in fb.export_video_quality_args("h264_nvenc", "fast", 8000, 4)
    assert "p6" in fb.export_video_quality_args("h264_nvenc", "quality", 8000, 4)
    assert "faster" in fb.export_video_quality_args("h264_qsv", "fast", 8000, 4)
    assert "slow" in fb.export_video_quality_args("h264_qsv", "quality", 8000, 4)
    assert "speed" in fb.export_video_quality_args("h264_amf", "fast", 8000, 4)
    assert "quality" in fb.export_video_quality_args("h264_amf", "quality", 8000, 4)
    assert "veryfast" in fb.export_video_quality_args("libx264", "fast", 8000, 4)
    assert "medium" in fb.export_video_quality_args("libx264", "quality", 8000, 4)
    assert "p6" in fb.export_video_quality_args("hevc_nvenc", "quality", 8000, 4)
    assert "10" in fb.export_video_quality_args("libsvtav1", "fast", 8000, 4)
    assert "-row-mt" in fb.export_video_quality_args("libaom-av1", "balanced", 8000, 4)


def test_output_color_args_do_not_label_8bit_as_hdr():
    sdr = fb.output_color_args("h264_nvenc", "sdr")
    assert sdr[:2] == ["-pix_fmt", "yuv420p"]
    assert "bt709" in sdr and "tv" in sdr
    hdr = fb.output_color_args("hevc_nvenc", "hdr10")
    assert "p010le" in hdr
    assert "bt2020" in hdr and "smpte2084" in hdr and "bt2020nc" in hdr
    with pytest.raises(ValueError, match="verified 10-bit HEVC or AV1"):
        fb.output_color_args("h264_nvenc", "hdr10")


def test_export_quality_audio_bitrate_reaches_hybrid_mux(tmp_path):
    spec = {
        "durationSec": 1,
        "audioBitrateKbps": 256,
        "tracks": [{"id": "a", "kind": "audio", "muted": False}],
        "clips": [{
            **_BASE_CLIP,
            "kind": "audio",
            "trackId": "a",
            "hasAudio": True,
        }],
    }
    cmd = fb.build_hybrid_audio_mux_command(
        spec, {"a": "/source.wav"}, "/browser.mp4", "/out.mp4", str(tmp_path)
    )
    assert cmd[cmd.index("-b:a") + 1] == "256k"


def test_audio_mastering_filter_is_optional_and_profile_specific():
    assert fb.audio_mastering_filter({}) == ""
    assert "loudnorm=I=-14:TP=-1" in fb.audio_mastering_filter({
        "audioMastering": "social",
    })
    assert "loudnorm=I=-16:TP=-1" in fb.audio_mastering_filter({
        "audioMastering": "voice",
    })
    assert "alimiter=limit=0.891251" in fb.audio_mastering_filter({
        "audioMastering": "social",
    })


def test_audio_bus_mixes_over_silent_timeline_anchor():
    graph = ";".join(fb._mix_audio_buses([{}, {}], ["a0", "a1"], 5.0, "out"))
    assert graph == (
        "anullsrc=r=48000:cl=stereo,atrim=duration=5.000000[mixanchor];"
        "[mixanchor][a0][a1]amix=inputs=3:normalize=0:dropout_transition=0[out]"
    )


def test_single_audio_clip_keeps_anull_passthrough():
    graph = ";".join(fb._mix_audio_buses([{}], ["a0"], 5.0, "out"))
    assert graph == "[a0]anull[out]"


def test_general_audio_is_padded_to_exact_timeline_duration(tmp_path):
    spec = _spec_with_caption(hasAudio=True)
    spec["durationSec"] = 5.0
    spec["_chunkIntermediate"] = True
    cmd = _build_general(spec, tmp_path, probe_audio=True)

    graph = cmd[cmd.index("-filter_complex") + 1]
    assert "apad=whole_dur=5.000000,atrim=duration=5.000000[atimeline]" in graph
    assert cmd[cmd.index("-map") + 1] == "[vout]"
    assert "[atimeline]" in cmd


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg unavailable")
def test_split_video_keeps_later_source_audio_after_first_part_is_separated(
    tmp_path,
):
    """Replacing only split part 1 with stems must not silence parts 2 and 3."""
    source = tmp_path / "source.mp4"
    vocals = tmp_path / "vocals.wav"
    music = tmp_path / "music.wav"
    output = tmp_path / "out.mp4"
    subprocess.run([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "color=blue:s=160x90:r=10:d=3",
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=3",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
        str(source),
    ], check=True)
    for path, frequency in ((vocals, 660), (music, 880)):
        subprocess.run([
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-f", "lavfi", "-i",
            f"sine=frequency={frequency}:sample_rate=48000:duration=3",
            str(path),
        ], check=True)

    def media_clip(clip_id, start, in_point, out_point, *, muted=False):
        return {
            "id": clip_id, "trackId": "v", "kind": "video", "assetId": "src",
            "startSec": start, "inPointSec": in_point, "outPointSec": out_point,
            "speed": 1, "opacity": 1, "volume": 1, "muted": muted,
            "effects": [], "transform": {}, "hasAudio": not muted,
        }

    spec = {
        "width": 160, "height": 90, "fps": 10, "durationSec": 3,
        "videoBitrateKbps": 500, "audioBitrateKbps": 128,
        "tracks": [
            {"id": "v", "kind": "video", "muted": False},
            {"id": "av", "kind": "audio", "muted": False},
            {"id": "am", "kind": "audio", "muted": False},
        ],
        "clips": [
            media_clip("part-1", 0, 0, 1, muted=True),
            media_clip("part-2", 1, 1, 2),
            media_clip("part-3", 2, 2, 3),
            {
                "id": "vocals", "trackId": "av", "kind": "audio",
                "assetId": "vocals", "startSec": 0, "inPointSec": 0,
                "outPointSec": 1, "speed": 1, "opacity": 1, "volume": 1,
                "muted": False, "hasAudio": True,
            },
            {
                "id": "music", "trackId": "am", "kind": "audio",
                "assetId": "music", "startSec": 0, "inPointSec": 0,
                "outPointSec": 1, "speed": 1, "opacity": 1, "volume": 1,
                "muted": False, "hasAudio": True,
            },
        ],
    }
    with patch.object(fb, "detect_video_encoder", return_value="libx264"), \
         patch.object(fb, "cuvid_decoder_for", return_value=None):
        cmd = fb.build_command(
            spec,
            {"src": str(source), "vocals": str(vocals), "music": str(music)},
            str(output),
            str(tmp_path),
        )
    render = subprocess.run(cmd, cwd=tmp_path, capture_output=True, text=True)
    assert render.returncode == 0, render.stderr[-2000:]

    later_audio = subprocess.run([
        "ffmpeg", "-hide_banner", "-ss", "1.25", "-t", "1.5", "-i", str(output),
        "-vn", "-af", "volumedetect", "-f", "null", "-",
    ], capture_output=True, text=True, check=True)
    assert "mean_volume: -inf" not in later_audio.stderr


def test_audio_chain_applies_explicit_clip_edge_fades():
    graph = fb._audio_chain({
        "startSec": 0, "inPointSec": 0, "outPointSec": 2, "speed": 1,
        "audioFadeInSec": 0.008, "audioFadeOutSec": 0.012,
    }, "0:a", "out")
    assert "afade=t=in:st=0:d=0.008000" in graph
    assert "afade=t=out:st=1.988000:d=0.012000" in graph


def test_hybrid_direct_mastering_is_after_whole_mix(tmp_path):
    spec = {
        "durationSec": 1,
        "audioMastering": "social",
        "tracks": [{"id": "a", "kind": "audio", "muted": False}],
        "clips": [{
            **_BASE_CLIP,
            "kind": "audio",
            "trackId": "a",
            "hasAudio": True,
        }],
    }
    cmd = fb.build_hybrid_audio_mux_command(
        spec, {"a": "/source.wav"}, "/browser.mp4", "/out.mp4", str(tmp_path)
    )
    graph = cmd[cmd.index("-filter_complex") + 1]
    assert graph.index("[hamix]") < graph.index("loudnorm=I=-14")


def test_build_command_libx264_caps_threads(tmp_path):
    with patch.object(fb, "detect_video_encoder", return_value="libx264"):
        cmd = fb.build_command(_SPEC, {}, str(tmp_path / "out.mp4"), str(tmp_path))
    assert "-threads" in cmd
    # filtergraph thread cap present
    assert "-filter_complex_threads" in cmd


# ── Encoder probe uses a resolution above NVENC's minimum (TASK-01b) ────────

def test_encoder_probe_resolution_clears_nvenc_minimum():
    """Regression guard: the probe MUST be >=256px, not 64x64, or NVENC is
    falsely rejected (it fails below ~145px) and silently demoted to QSV/CPU."""
    src = inspect.getsource(fb._encoder_works)
    assert "s=256x256" in src       # the actual lavfi probe size
    assert "s=64x64" not in src     # the old, too-small size (docstring may mention it)


def test_hdr_encoder_probe_uses_real_ten_bit_pixel_contract():
    completed = type("Completed", (), {"returncode": 0})()
    with patch.object(fb.subprocess, "run", return_value=completed) as run:
        assert fb._encoder_works("hevc_nvenc", ten_bit=True)
    cmd = run.call_args.args[0]
    assert cmd[cmd.index("-pix_fmt") + 1] == "p010le"


def test_hdr_encoder_detection_never_falls_back_to_h264():
    fb.detect_hdr10_encoder.cache_clear()
    listed = type("Completed", (), {"stdout": "hevc_nvenc libx265"})()
    with patch.object(fb.subprocess, "run", return_value=listed), \
         patch.object(fb, "_encoder_works", return_value=False):
        assert fb.detect_hdr10_encoder("hevc") is None
    fb.detect_hdr10_encoder.cache_clear()


def test_encoder_listing_probes_have_a_bounded_timeout():
    listed = type("Completed", (), {"stdout": "h264_nvenc hevc_nvenc"})()
    fb.detect_video_encoder.cache_clear()
    with patch.object(fb.subprocess, "run", return_value=listed) as run, \
         patch.object(fb, "_encoder_works", return_value=True):
        assert fb.detect_video_encoder("h264") == "h264_nvenc"
    assert run.call_args.kwargs["timeout"] == 15

    fb.detect_hdr10_encoder.cache_clear()
    with patch.object(fb.subprocess, "run", return_value=listed) as run, \
         patch.object(fb, "_encoder_works", return_value=True):
        assert fb.detect_hdr10_encoder("hevc") == "hevc_nvenc"
    assert run.call_args.kwargs["timeout"] == 15
    fb.detect_video_encoder.cache_clear()
    fb.detect_hdr10_encoder.cache_clear()


# ── Rotation + zoom parity (TASK-20): filtergraph construction ──────────────

def test_rotation_adds_rotate_filter_and_alpha():
    clip = {**_BASE_CLIP, "transform": {"rotation": 90}}
    chain = fb._visual_chain(clip, 0, 1920, 1080, "v0")
    assert "yuva420p" in chain                  # transparent corners need alpha
    assert "rotate=a=1.570796" in chain         # 90° in radians, clockwise
    assert "ow=rotw(1.570796)" in chain         # canvas expanded to bounding box
    assert "c=none" in chain


def test_no_rotation_means_no_rotate_filter():
    chain = fb._visual_chain(dict(_BASE_CLIP), 0, 1920, 1080, "v0")
    assert "rotate=" not in chain


def test_zoom_in_adds_time_varying_scale():
    clip = {**_BASE_CLIP, "effects": [{"type": "zoom-in", "params": {"amount": 0.24}}]}
    chain = fb._visual_chain(clip, 0, 1920, 1080, "v0")
    assert "scale=eval=frame" in chain
    assert "(1+0.2400*" in chain                # zoom-in grows from 1
    assert "clip(t/" in chain                   # time-based smoothstep
    assert "yuva420p" not in chain              # zoom alone needs no alpha


def test_zoom_out_uses_inverted_progress():
    clip = {**_BASE_CLIP, "effects": [{"type": "zoom-out", "params": {"amount": 0.5}}]}
    chain = fb._visual_chain(clip, 0, 1920, 1080, "v0")
    assert "(1+0.5000*(1-" in chain             # starts zoomed, settles at 1


def test_multiple_zoom_effects_multiply():
    expr = fb._zoom_expr({
        "effects": [
            {"type": "zoom-in", "params": {"amount": 0.2}},
            {"type": "zoom-out", "params": {"amount": 0.3}},
        ],
    }, 5.0)
    assert expr.count("(1+") == 2 and ")*(" in expr


# ── Fast path: single full-frame clip → direct transcode (no filtergraph) ───

def _single_clip_spec(**clip_over):
    clip = {
        "id": "c1", "assetId": "A", "trackId": "t", "kind": "video",
        "startSec": 0, "inPointSec": 0, "outPointSec": 10.0, "speed": 1,
        "opacity": 1, "volume": 1, "hasAudio": True, "muted": False,
        "effects": [], "transform": {}, "adjust": {},
    }
    clip.update(clip_over)
    return {
        "width": 1920, "height": 1080, "fps": 30, "durationSec": 10.0,
        "videoBitrateKbps": 8000,
        "tracks": [{"id": "t", "kind": "video", "muted": False}],
        "clips": [clip],
    }


def _build_fast(spec, src_w=1920, src_h=1080, cuvid=None, tmp="."):
    """Build a command with detect_video_encoder + probe + cuvid stubbed.
    `cuvid` controls the GPU decoder selection (None = no cuvid → -hwaccel auto)."""
    with patch.object(fb, "detect_video_encoder", return_value="h264_nvenc"), \
         patch.object(fb, "cuvid_decoder_for", return_value=cuvid), \
         patch("app.ffmpeg_utils.probe", return_value={"width": src_w, "height": src_h}):
        return fb.build_command(spec, {"A": "/in.mp4"}, "/out.mp4", tmp)


def test_fast_path_single_clip_skips_filtergraph():
    cmd = _build_fast(_single_clip_spec())
    assert "-filter_complex" not in cmd        # the whole point
    assert "-hwaccel" in cmd                   # HW decode straight to encode
    assert "-c:a" in cmd                       # audio kept
    assert "-vf" not in cmd                    # same dims → no scale at all


def test_fast_path_scales_same_aspect_source():
    cmd = _build_fast(_single_clip_spec(), src_w=3840, src_h=2160)  # 4K → 1080p
    assert "-filter_complex" not in cmd
    assert "scale=1920:1080" in " ".join(cmd)


def test_fast_path_trim_uses_input_seek():
    spec = _single_clip_spec(inPointSec=5.0, outPointSec=15.0)
    cmd = _build_fast(spec)
    i = cmd.index("-ss")
    assert cmd[i + 1] == "5.0000"
    assert cmd.index("-ss") < cmd.index("-i")  # input seeking (fast + accurate)


def test_fast_path_no_audio_when_clip_has_none():
    cmd = _build_fast(_single_clip_spec(hasAudio=False))
    assert "-an" in cmd and "-c:a" not in cmd


def test_smart_copy_requires_full_untouched_h264_source():
    meta = {
        "width": 1920, "height": 1080, "durationSec": 10,
        "fps": 30, "videoCodec": "h264", "audioCodec": "aac",
        "audioChannels": 2, "audioSampleRate": 48000,
        "pixFmt": "yuv420p", "sampleAspectRatio": "1:1", "rotation": 0,
    }
    with patch("app.ffmpeg_utils.probe", return_value=meta), \
         patch.object(fb, "_has_audio_stream", return_value=True):
        cmd = fb.build_command(
            _single_clip_spec(), {"A": "/in.mp4"}, "/out.mp4", "."
        )

    assert cmd[cmd.index("-c:v") + 1] == "copy"
    assert cmd[cmd.index("-c:a") + 1] == "copy"
    assert "-r" not in cmd and "-filter_complex" not in cmd


def test_hevc_request_uses_hevc_encoder_and_matching_pixel_contract():
    spec = {**_single_clip_spec(), "videoCodec": "hevc"}
    meta = {
        "width": 1920, "height": 1080, "durationSec": 10,
        "fps": 30, "videoCodec": "h264", "audioCodec": "aac",
        "audioChannels": 2, "audioSampleRate": 48000,
        "pixFmt": "yuv420p", "sampleAspectRatio": "1:1", "rotation": 0,
    }
    with patch("app.ffmpeg_utils.probe", return_value=meta), \
         patch.object(fb, "detect_hdr10_encoder", return_value="hevc_nvenc"):
        cmd = fb.build_command(spec, {"A": "/in.mp4"}, "/out.mp4", ".")
    assert cmd[cmd.index("-c:v") + 1] == "hevc_nvenc"
    assert cmd[cmd.index("-pix_fmt") + 1] == "yuv420p"
    assert cmd[cmd.index("-tag:v") + 1] == "hvc1"


def test_hdr10_preserves_true_pq_source_and_signals_output():
    spec = {**_single_clip_spec(), "videoCodec": "hevc", "dynamicRange": "hdr10"}
    meta = {
        "width": 1920, "height": 1080, "durationSec": 10,
        "fps": 30, "videoCodec": "h264", "audioCodec": "aac",
        "audioChannels": 2, "audioSampleRate": 48000,
        "pixFmt": "yuv420p10le", "sampleAspectRatio": "1:1", "rotation": 0,
        "colorPrimaries": "bt2020", "colorTransfer": "smpte2084",
        "colorSpace": "bt2020nc", "colorRange": "tv",
    }
    with patch("app.ffmpeg_utils.probe", return_value=meta), \
         patch.object(fb, "detect_video_encoder", return_value="hevc_nvenc"):
        cmd = fb.build_command(spec, {"A": "/in.mp4"}, "/out.mp4", ".")
    joined = " ".join(cmd)
    assert "-pix_fmt p010le" in joined
    assert "-color_primaries bt2020" in joined
    assert "-color_trc smpte2084" in joined


def test_hdr10_rejects_when_no_ten_bit_encoder_is_available():
    spec = {**_single_clip_spec(), "videoCodec": "hevc", "dynamicRange": "hdr10"}
    meta = {
        "width": 1920, "height": 1080, "durationSec": 10,
        "fps": 30, "videoCodec": "h264", "audioCodec": "aac",
        "audioChannels": 2, "audioSampleRate": 48000,
        "pixFmt": "yuv420p10le", "sampleAspectRatio": "1:1", "rotation": 0,
        "colorPrimaries": "bt2020", "colorTransfer": "smpte2084",
        "colorSpace": "bt2020nc", "colorRange": "tv",
    }
    with patch("app.ffmpeg_utils.probe", return_value=meta), \
         patch.object(fb, "detect_hdr10_encoder", return_value=None):
        with pytest.raises(ValueError, match="working 10-bit HEVC encoder"):
            fb.build_command(spec, {"A": "/in.mp4"}, "/out.mp4", ".")


def test_hdr10_rejects_sdr_source_instead_of_mislabeling_it():
    spec = {**_single_clip_spec(), "videoCodec": "hevc", "dynamicRange": "hdr10"}
    meta = {
        "width": 1920, "height": 1080, "durationSec": 10,
        "fps": 30, "videoCodec": "h264", "audioCodec": "aac",
        "audioChannels": 2, "audioSampleRate": 48000,
        "pixFmt": "yuv420p", "sampleAspectRatio": "1:1", "rotation": 0,
    }
    with patch("app.ffmpeg_utils.probe", return_value=meta):
        with pytest.raises(ValueError, match="10-bit BT.2020/PQ source"):
            fb.build_command(spec, {"A": "/in.mp4"}, "/out.mp4", ".")


def test_sdr_fast_path_tonemaps_hdr10_source():
    spec = {**_single_clip_spec(), "videoCodec": "h264", "dynamicRange": "sdr"}
    meta = {
        "width": 1920, "height": 1080, "durationSec": 10,
        "fps": 30, "videoCodec": "hevc", "audioCodec": "aac",
        "audioChannels": 2, "audioSampleRate": 48000,
        "pixFmt": "yuv420p10le", "sampleAspectRatio": "1:1", "rotation": 0,
        "colorPrimaries": "bt2020", "colorTransfer": "smpte2084",
        "colorSpace": "bt2020nc", "colorRange": "tv",
    }
    with patch("app.ffmpeg_utils.probe", return_value=meta), \
         patch.object(fb, "detect_video_encoder", return_value="h264_nvenc"):
        cmd = fb.build_command(spec, {"A": "/in.mp4"}, "/out.mp4", ".")
    vf = cmd[cmd.index("-vf") + 1]
    assert "zscale=t=linear" in vf and "tonemap=tonemap=hable" in vf
    assert "-hwaccel" not in cmd
    assert cmd[cmd.index("-color_primaries") + 1] == "bt709"


def test_sdr_fast_path_tonemaps_hlg_source_instead_of_retagging_it():
    spec = {**_single_clip_spec(), "videoCodec": "h264", "dynamicRange": "sdr"}
    meta = {
        "width": 1920, "height": 1080, "durationSec": 10,
        "fps": 30, "videoCodec": "hevc", "audioCodec": "aac",
        "audioChannels": 2, "audioSampleRate": 48000,
        "pixFmt": "yuv420p10le", "sampleAspectRatio": "1:1", "rotation": 0,
        "colorPrimaries": "bt2020", "colorTransfer": "arib-std-b67",
        "colorSpace": "bt2020nc", "colorRange": "tv",
    }
    with patch("app.ffmpeg_utils.probe", return_value=meta), \
         patch.object(fb, "detect_video_encoder", return_value="h264_nvenc"):
        cmd = fb.build_command(spec, {"A": "/in.mp4"}, "/out.mp4", ".")
    vf = cmd[cmd.index("-vf") + 1]
    assert "zscale=t=linear" in vf and "tonemap=tonemap=hable" in vf
    assert "-hwaccel" not in cmd


def test_hdr_metadata_enables_nvenc_sei_passthrough():
    meta = {
        "pixFmt": "yuv420p10le", "colorPrimaries": "bt2020",
        "colorTransfer": "smpte2084", "colorSpace": "bt2020nc",
    }
    with patch.object(fb, "_encoder_option_supported", return_value=True):
        assert fb.hdr_metadata_args("hevc_nvenc", meta) == ["-extra_sei", "1"]


def test_hdr_metadata_injects_x265_mastering_display_and_cll():
    meta = {
        "pixFmt": "yuv420p10le", "colorPrimaries": "bt2020",
        "colorTransfer": "smpte2084", "colorSpace": "bt2020nc",
        "masteringDisplay": {
            "green_x": "13250/50000", "green_y": "34500/50000",
            "blue_x": "7500/50000", "blue_y": "3000/50000",
            "red_x": "34000/50000", "red_y": "16000/50000",
            "white_point_x": "15635/50000", "white_point_y": "16450/50000",
            "max_luminance": "10000000/10000",
            "min_luminance": "50/10000",
        },
        "contentLightLevel": {"max_content": 1000, "max_average": 400},
    }
    args = fb.hdr_metadata_args("libx265", meta)
    assert args[0] == "-x265-params"
    assert "master-display=G(13250,34500)" in args[1]
    assert "L(10000000,50)" in args[1]
    assert "max-cll=1000,400" in args[1]


def test_sdr_general_path_tonemaps_hdr_before_compositing(tmp_path):
    spec = {
        **_single_clip_spec(),
        "videoCodec": "h264",
        "dynamicRange": "sdr",
        "_disableFastPath": True,
    }
    meta = {
        "width": 1920, "height": 1080, "durationSec": 10,
        "fps": 30, "videoCodec": "hevc", "audioCodec": "aac",
        "audioChannels": 2, "audioSampleRate": 48000,
        "pixFmt": "yuv420p10le", "sampleAspectRatio": "1:1", "rotation": 0,
        "colorPrimaries": "bt2020", "colorTransfer": "smpte2084",
        "colorSpace": "bt2020nc", "colorRange": "tv",
    }
    with patch("app.ffmpeg_utils.probe", return_value=meta), \
         patch.object(fb, "detect_video_encoder", return_value="h264_nvenc"):
        cmd = fb.build_command(spec, {"A": "/in.mp4"}, "/out.mp4", str(tmp_path))
    graph = cmd[cmd.index("-filter_complex") + 1]
    assert "zscale=t=linear" in graph and "tonemap=tonemap=hable" in graph
    assert "-hwaccel" not in cmd and "h264_cuvid" not in cmd


@pytest.mark.parametrize(
    "meta_override",
    [
        {"fps": 29.97},
        {"videoCodec": "hevc"},
        {"pixFmt": "yuv420p10le"},
        {"sampleAspectRatio": "4:3"},
        {"rotation": 90},
        {"durationSec": 9.5},
        {"durationSec": 9.9},
    ],
)
def test_smart_copy_rejects_non_identical_output_contract(meta_override):
    meta = {
        "width": 1920, "height": 1080, "durationSec": 10,
        "fps": 30, "videoCodec": "h264", "audioCodec": "aac",
        "audioChannels": 2, "audioSampleRate": 48000,
        "pixFmt": "yuv420p", "sampleAspectRatio": "1:1", "rotation": 0,
        **meta_override,
    }
    with patch("app.ffmpeg_utils.probe", return_value=meta), \
         patch.object(fb, "detect_video_encoder", return_value="libx264"):
        cmd = fb.build_command(
            _single_clip_spec(), {"A": "/in.mp4"}, "/out.mp4", "."
        )

    assert cmd[cmd.index("-c:v") + 1] == "libx264"


def test_fast_path_allows_captions_via_ass(tmp_path):
    # A single full-frame video + caption track should stay on the fast path,
    # burning subs through libass (ass=) instead of the full overlay graph.
    spec = _single_clip_spec()
    spec["tracks"].append({"id": "tt", "kind": "text", "muted": False})
    spec["clips"].append({
        "id": "cap", "trackId": "tt", "kind": "text", "startSec": 0,
        "inPointSec": 0, "outPointSec": 3, "speed": 1,
        "textData": {"content": "hello", "fontSize": 54, "color": "#fff"},
    })
    cmd = _build_fast(spec, tmp=str(tmp_path))
    assert "-filter_complex" not in cmd           # still the fast path
    assert "ass=captions.ass" in " ".join(cmd)    # captions burned via libass
    assert (tmp_path / "captions.ass").exists()   # ASS written to work_dir


@pytest.mark.parametrize("clip_over", [
    {"opacity": 0.5},                                          # needs alpha
    {"effects": [{"type": "fade-in", "params": {}}]},          # needs fades
    {"speed": 2.0},                                            # needs setpts
    {"startSec": 3.0},                                         # black lead-in
    {"adjust": {"brightness": 10}},                            # needs eq
    {"transform": {"rotation": 90}},                           # needs rotate
    {"volume": 0.5},                                           # needs volume
])
def test_fast_path_rejected_when_compositing_needed(clip_over):
    cmd = _build_fast(_single_clip_spec(**clip_over))
    assert "-filter_complex" in cmd            # fell back to the general graph


def test_fast_path_rejected_for_letterboxed_source():
    # 1440x1080 (4:3) into a 16:9 frame needs black bars → general path.
    cmd = _build_fast(_single_clip_spec(), src_w=1440, src_h=1080)
    assert "-filter_complex" in cmd


def test_fast_path_rejected_for_two_clips():
    spec = _single_clip_spec()
    spec["clips"].append({**spec["clips"][0], "id": "c2", "startSec": 0})
    cmd = _build_fast(spec)
    assert "-filter_complex" in cmd


# ── Fast path, GPU cuvid decoder (av1_cuvid etc.) ───────────────────────────

def _add_blur_sticker(spec: dict, **over) -> dict:
    spec["tracks"].append({"id": "fx", "kind": "fx", "muted": False})
    clip = {
        "id": "fx1", "assetId": None, "trackId": "fx", "kind": "fx",
        "startSec": 1.0, "inPointSec": 0.0, "outPointSec": 2.0, "speed": 1,
        "fxData": {"type": "blur-sticker", "x": 0.5, "y": 0.5, "w": 0.25, "h": 0.2, "blurPx": 18, "radius": 8},
    }
    clip.update(over)
    spec["clips"].append(clip)
    return spec


def test_fast_path_rejected_for_blur_sticker(tmp_path):
    spec = _add_blur_sticker(_single_clip_spec(hasAudio=False))
    with patch.object(fb, "detect_video_encoder", return_value="libx264"), \
         patch.object(fb, "cuvid_decoder_for", return_value=None), \
         patch.object(fb, "_has_audio_stream", return_value=False):
        cmd = fb.build_command(spec, {"A": "/in.mp4"}, str(tmp_path / "out.mp4"), str(tmp_path))
    graph = cmd[cmd.index("-filter_complex") + 1]
    assert "-filter_complex" in cmd
    # gblur to match the canvas CSS Gaussian blur(σ=N) — see _canvas_fill_filters.
    assert "gblur=sigma=" in graph
    assert "enable='between(t,1.0000,3.0000)'" in graph


def test_blur_sticker_renders_below_captions(tmp_path):
    spec = _add_blur_sticker(_spec_with_caption(hasAudio=False))
    with patch.object(fb, "detect_video_encoder", return_value="libx264"), \
         patch.object(fb, "cuvid_decoder_for", return_value=None), \
         patch.object(fb, "_has_audio_stream", return_value=False):
        cmd = fb.build_command(spec, {"A": "/in.mp4"}, str(tmp_path / "out.mp4"), str(tmp_path))
    graph = cmd[cmd.index("-filter_complex") + 1]
    assert graph.index("gblur=sigma=") < graph.index("ass=captions.ass")


def test_fast_path_cuvid_av1_4k_decodes_and_resizes_on_gpu():
    cmd = _build_fast(_single_clip_spec(), src_w=3840, src_h=2160, cuvid="av1_cuvid")
    s = " ".join(cmd)
    assert "-c:v av1_cuvid" in s              # forced GPU decoder (not libaom!)
    assert "-resize 1920x1080" in s           # GPU-side scale during decode
    assert "-vf" not in cmd                   # no CPU scale filter
    assert "-hwaccel" not in cmd              # explicit decoder replaces hwaccel


def test_fast_path_cuvid_same_dims_no_resize():
    cmd = _build_fast(_single_clip_spec(), cuvid="h264_cuvid")
    s = " ".join(cmd)
    assert "-c:v h264_cuvid" in s
    assert "-resize" not in cmd               # same size → nothing to scale


def test_fast_path_no_cuvid_falls_back_to_cpu_scale():
    # cuvid unavailable for this source → -hwaccel auto + CPU scale.
    cmd = _build_fast(_single_clip_spec(), src_w=3840, src_h=2160, cuvid=None)
    s = " ".join(cmd)
    assert "-hwaccel auto" in s
    assert "scale=1920:1080" in s and "_cuvid" not in s


# ── cuvid_decoder_for selection logic (probe-gated) ─────────────────────────

def test_cuvid_decoder_av1_8bit_selected():
    with patch.object(fb, "_available_cuvid", return_value=frozenset({"av1_cuvid"})), \
         patch.object(fb, "_probe_codec", return_value=("av1", "yuv420p")):
        assert fb.cuvid_decoder_for("/x.mp4", "h264_nvenc") == "av1_cuvid"


def test_cuvid_decoder_rejected_for_10bit():
    with patch.object(fb, "_available_cuvid", return_value=frozenset({"hevc_cuvid"})), \
         patch.object(fb, "_probe_codec", return_value=("hevc", "yuv420p10le")):
        assert fb.cuvid_decoder_for("/x.mp4", "h264_nvenc") is None


def test_cuvid_decoder_rejected_without_nvenc():
    with patch.object(fb, "_available_cuvid", return_value=frozenset({"av1_cuvid"})), \
         patch.object(fb, "_probe_codec", return_value=("av1", "yuv420p")):
        assert fb.cuvid_decoder_for("/x.mp4", "libx264") is None       # CPU encoder
        assert fb.cuvid_decoder_for("/x.mp4", "h264_qsv") is None       # non-NVIDIA


def test_cuvid_decoder_rejected_when_not_in_build():
    with patch.object(fb, "_available_cuvid", return_value=frozenset()), \
         patch.object(fb, "_probe_codec", return_value=("av1", "yuv420p")):
        assert fb.cuvid_decoder_for("/x.mp4", "h264_nvenc") is None


def _build_general(spec, work_dir, *, probe_audio):
    """Build via the general path, with the source audio-stream probe stubbed.
    A letterboxed source (4:3 into 16:9) needs the overlay graph, which forces
    the general path even for a single captioned clip (captions alone now take
    the fast path)."""
    with patch.object(fb, "detect_video_encoder", return_value="libx264"), \
         patch.object(fb, "cuvid_decoder_for", return_value=None), \
         patch.object(fb, "_has_audio_stream", return_value=probe_audio), \
         patch("app.ffmpeg_utils.probe", return_value={"width": 1440, "height": 1080}):
        return fb.build_command(spec, {"A": "/in.mp4"}, "/out.mp4", str(work_dir))


def _spec_with_caption(**clip_over):
    s = _single_clip_spec(**clip_over)
    s["tracks"].append({"id": "tt", "kind": "text", "muted": False})
    s["clips"].append({
        "id": "tx", "trackId": "tt", "kind": "text", "startSec": 0, "durationSec": 10.0,
        "inPointSec": 0, "outPointSec": 10.0, "speed": 1, "textData": {"content": "hi"},
    })
    return s


def test_audio_included_when_source_has_stream_despite_false_flag(tmp_path):
    # hasAudio=False (frontend waveform missed) but the source HAS audio → keep it.
    cmd = _build_general(_spec_with_caption(hasAudio=False), tmp_path, probe_audio=True)
    assert "[0:a]" in " ".join(cmd) and "-c:a" in cmd


def test_audio_dropped_when_source_truly_silent(tmp_path):
    cmd = _build_general(_spec_with_caption(hasAudio=False), tmp_path, probe_audio=False)
    assert "[0:a]" not in " ".join(cmd) and "-c:a" not in cmd


def test_audio_dropped_for_muted_clip_even_with_stream(tmp_path):
    cmd = _build_general(_spec_with_caption(hasAudio=True, muted=True), tmp_path, probe_audio=True)
    assert "-c:a" not in cmd


def test_general_path_uses_cuvid_for_av1_input():
    # A composited (transform) AV1 clip → general path → input gets -c:v av1_cuvid.
    spec = _single_clip_spec(transform={"rotation": 90})  # disqualifies fast path
    with patch.object(fb, "detect_video_encoder", return_value="h264_nvenc"), \
         patch.object(fb, "cuvid_decoder_for", return_value="av1_cuvid"), \
         patch("app.ffmpeg_utils.probe", return_value={"width": 3840, "height": 2160}):
        cmd = fb.build_command(spec, {"A": "/in.mp4"}, "/out.mp4", ".")
    s = " ".join(cmd)
    assert "-filter_complex" in cmd           # composited
    assert "-c:v av1_cuvid" in s and "-i /in.mp4" in s   # forced GPU decoder on the input
    assert cmd.index("av1_cuvid") < cmd.index("/in.mp4")  # decoder is an input option


# ── Shared-source input dedup (scene split) ─────────────────────────────────

def _scene_split_spec(n: int):
    """Timeline of n contiguous segments of ONE source — what a scene split
    produces. Each segment trims a 10s window and carries audio."""
    clips = [
        {
            "id": f"c{i}", "assetId": "A", "trackId": "t", "kind": "video",
            "startSec": i * 10.0, "inPointSec": i * 10.0, "outPointSec": (i + 1) * 10.0,
            "speed": 1, "opacity": 1, "volume": 1, "hasAudio": True, "muted": False,
            "effects": [], "transform": {}, "adjust": {},
        }
        for i in range(n)
    ]
    return {
        "width": 1920, "height": 1080, "fps": 30, "durationSec": n * 10.0,
        "videoBitrateKbps": 8000,
        "tracks": [{"id": "t", "kind": "video", "muted": False}],
        "clips": clips,
    }


def test_split_segments_use_windowed_inputs():
    # Segments of one source that can't merge back (here each was edited with a
    # zoom effect) get ONE seeked input each: no whole-file decode per clip, and
    # no split buffer between far-apart trims (the OOM trap on long videos).
    spec = _scene_split_spec(5)
    for c in spec["clips"]:
        c["effects"] = [{"type": "zoom-in", "params": {"amount": 0.2}}]  # blocks merge
    with patch.object(fb, "detect_video_encoder", return_value="libx264"), \
         patch.object(fb, "cuvid_decoder_for", return_value=None), \
         patch.object(fb, "_has_audio_stream", return_value=True), \
         patch("app.ffmpeg_utils.probe", return_value={"width": 1920, "height": 1080}):
        cmd = fb.build_command(spec, {"A": "/in.mp4"}, "/out.mp4", ".")
    s = " ".join(cmd)
    assert cmd.count("-i") == 5                       # one windowed input per segment
    assert "split=" not in s and "asplit=" not in s   # no fan-out buffering
    assert "-ss 40.0000" in s and "-t 10.0000" in s   # last segment seeked to its window


def test_many_segments_fall_back_to_software_decode():
    # Past the HW-decoder ceiling, decode in software so dozens of clips don't
    # exhaust VRAM with a cuvid context each.
    spec = _scene_split_spec(fb._MAX_HW_DECODERS + 4)
    for i, c in enumerate(spec["clips"]):
        c["effects"] = [{"type": "zoom-in", "params": {"amount": 0.1 + i * 0.01}}]
    with patch.object(fb, "detect_video_encoder", return_value="h264_nvenc"), \
         patch.object(fb, "cuvid_decoder_for", return_value="h264_cuvid"), \
         patch.object(fb, "_has_audio_stream", return_value=True), \
         patch("app.ffmpeg_utils.probe", return_value={"width": 1920, "height": 1080}):
        cmd = fb.build_command(spec, {"A": "/in.mp4"}, "/out.mp4", ".")
    s = " ".join(cmd)
    assert "cuvid" not in s and "-hwaccel" not in s   # software decode (bounded VRAM)
    assert "h264_nvenc" in s                          # still hardware-encoded


def test_distinct_sources_are_not_deduped():
    # Two different files must keep two inputs and need no split.
    spec = _scene_split_spec(2)
    spec["clips"][1]["assetId"] = "B"
    with patch.object(fb, "detect_video_encoder", return_value="libx264"), \
         patch.object(fb, "cuvid_decoder_for", return_value=None), \
         patch.object(fb, "_has_audio_stream", return_value=True), \
         patch("app.ffmpeg_utils.probe", return_value={"width": 1920, "height": 1080}):
        cmd = fb.build_command(spec, {"A": "/a.mp4", "B": "/b.mp4"}, "/out.mp4", ".")
    assert cmd.count("-i") == 2
    s = " ".join(cmd)
    assert "split=" not in s and "[0:v]" in s and "[1:v]" in s


# ── _merge_contiguous_runs (scene-split collapse) ───────────────────────────

def test_merge_collapses_unedited_split():
    # A 5-way split with no edits collapses back to one clip spanning the source.
    clips = _scene_split_spec(5)["clips"]
    merged = fb._merge_contiguous_runs(clips)
    vids = [c for c in merged if c["kind"] == "video"]
    assert len(vids) == 1
    assert vids[0]["inPointSec"] == 0 and vids[0]["outPointSec"] == 50.0


def test_merge_breaks_at_edited_segment():
    # Editing one segment (a zoom effect) splits the run around it.
    clips = _scene_split_spec(5)["clips"]
    clips[2] = {**clips[2], "effects": [{"type": "zoom-in", "params": {"amount": 0.3}}]}
    vids = [c for c in fb._merge_contiguous_runs(clips) if c["kind"] == "video"]
    assert len(vids) == 3  # [0-20], [20-30 zoom], [30-50]


def test_merge_breaks_on_trim_gap():
    # A gap in source (one segment removed mid-run) must not be bridged.
    clips = _scene_split_spec(4)["clips"]
    del clips[1]  # drop the 10-20s segment → source gap between 10 and 20
    vids = [c for c in fb._merge_contiguous_runs(clips) if c["kind"] == "video"]
    assert len(vids) == 2  # [0-10] and [20-40]


def test_merge_keeps_distinct_assets_separate():
    clips = _scene_split_spec(2)["clips"]
    clips[1]["assetId"] = "B"
    vids = [c for c in fb._merge_contiguous_runs(clips) if c["kind"] == "video"]
    assert len(vids) == 2


def test_huge_graph_spills_to_filter_complex_script(tmp_path):
    """A many-clip composited timeline (each segment edited so it can't merge)
    builds a filtergraph too long to pass inline — on Windows that overflowed the
    command line (WinError 206). Past the threshold the graph is written to a side
    file and referenced with -filter_complex_script instead."""
    spec = _scene_split_spec(150)
    for i, c in enumerate(spec["clips"]):
        c["effects"] = [{"type": "zoom-in", "params": {"amount": 0.1 + i * 0.001}}]  # blocks merge
    with patch.object(fb, "detect_video_encoder", return_value="libx264"), \
         patch.object(fb, "cuvid_decoder_for", return_value=None), \
         patch.object(fb, "_has_audio_stream", return_value=True), \
         patch.object(fb, "_MAX_GENERAL_INPUTS", 200), \
         patch("app.ffmpeg_utils.probe", return_value={"width": 1920, "height": 1080}):
        cmd = fb.build_command(spec, {"A": "/in.mp4"}, "/out.mp4", str(tmp_path))

    assert "-filter_complex_script" in cmd          # spilled to a file
    assert "-filter_complex" not in cmd             # NOT passed inline
    assert "filtergraph.txt" in cmd                 # referenced by basename
    written = (tmp_path / "filtergraph.txt").read_text(encoding="utf-8")
    assert "overlay=" in written and "scale=" in written   # the real graph landed in the file
    assert "[vout]" in cmd                          # video map still wired up


def test_too_many_independent_inputs_fail_before_spawn(tmp_path):
    spec = _scene_split_spec(fb._MAX_GENERAL_INPUTS + 1)
    for i, clip in enumerate(spec["clips"]):
        clip["effects"] = [{"type": "zoom-in", "params": {"amount": 0.1 + i * 0.001}}]
    with patch.object(fb, "detect_video_encoder", return_value="libx264"), \
         patch.object(fb, "cuvid_decoder_for", return_value=None), \
         patch.object(fb, "_has_audio_stream", return_value=True):
        with pytest.raises(ValueError, match="safe limit"):
            fb.build_command(spec, {"A": "/in.mp4"}, "/out.mp4", str(tmp_path))


def test_small_graph_stays_inline(tmp_path):
    """The common case keeps the graph inline (no stray side file) — the spill is
    only for pathologically long commands."""
    spec = _scene_split_spec(3)
    for c in spec["clips"]:
        c["effects"] = [{"type": "zoom-in", "params": {"amount": 0.2}}]  # blocks merge
    with patch.object(fb, "detect_video_encoder", return_value="libx264"), \
         patch.object(fb, "cuvid_decoder_for", return_value=None), \
         patch.object(fb, "_has_audio_stream", return_value=True), \
         patch("app.ffmpeg_utils.probe", return_value={"width": 1920, "height": 1080}):
        cmd = fb.build_command(spec, {"A": "/in.mp4"}, "/out.mp4", str(tmp_path))

    assert "-filter_complex" in cmd
    assert "-filter_complex_script" not in cmd
    assert not (tmp_path / "filtergraph.txt").exists()


def test_export_after_split_with_caption_stays_small(tmp_path):
    # The reported crash: split + burned captions OOM'd a deep filtergraph. After
    # the merge it's ONE full-frame clip + captions → the fast path: one input,
    # no overlay graph at all, captions burned via libass.
    spec = _scene_split_spec(8)
    spec["tracks"].append({"id": "tt", "kind": "text", "muted": False})
    spec["clips"].append({
        "id": "tx", "trackId": "tt", "kind": "text", "startSec": 0, "durationSec": 80.0,
        "inPointSec": 0, "outPointSec": 80.0, "speed": 1, "textData": {"content": "hi"},
    })
    with patch.object(fb, "detect_video_encoder", return_value="libx264"), \
         patch.object(fb, "cuvid_decoder_for", return_value=None), \
         patch.object(fb, "_has_audio_stream", return_value=True), \
         patch("app.ffmpeg_utils.probe", return_value={"width": 1920, "height": 1080}):
        cmd = fb.build_command(spec, {"A": "/in.mp4"}, "/out.mp4", str(tmp_path))
    s = " ".join(cmd)
    assert "-filter_complex" not in cmd       # fast path, no compositing graph
    assert cmd.count("-i") == 1
    assert "split=" not in s and "amix" not in s
    assert "ass=captions.ass" in s


# ── Rotation + zoom parity: REAL renders with pixel checks ──────────────────
# Skipped when ffmpeg isn't installed (e.g. the CI Lite environment).

pytestmark_ffmpeg = pytest.mark.skipif(
    shutil.which("ffmpeg") is None, reason="ffmpeg not installed"
)


def _gen(args: list[str], timeout: int = 60) -> None:
    r = subprocess.run(["ffmpeg", "-hide_banner", "-y", *args],
                       capture_output=True, text=True, timeout=timeout)
    assert r.returncode == 0, r.stderr[-800:]


_FPS = 10  # all _clip_spec renders use fps=10


def _row(path: str, frame_n: int, y: int, width: int) -> bytes:
    """RGB bytes of pixel row `y` of frame `frame_n` (width*3 bytes).

    Seeks by time (accurate output seek, after -i) and grabs the whole frame as
    rawvideo, then slices the row in Python — avoids the fragile select/crop
    filtergraph that doesn't configure cleanly with -frames:v 1.
    """
    # Accurate output seek keeps the first frame with PTS >= sec, so seek into
    # the gap just BEFORE the target frame's PTS (N/fps). Seeking at/after it
    # would skip the last frame entirely (zero packets).
    sec = max(0.0, (frame_n - 0.5) / _FPS)
    r = subprocess.run(
        ["ffmpeg", "-hide_banner", "-i", path, "-ss", f"{sec:.4f}",
         "-vf", "format=rgb24", "-frames:v", "1", "-f", "rawvideo", "-"],
        capture_output=True, timeout=60,
    )
    assert r.returncode == 0, r.stderr.decode(errors="replace")[-800:]
    rowbytes = width * 3
    assert len(r.stdout) >= (y + 1) * rowbytes, f"frame too small: {len(r.stdout)} bytes"
    return r.stdout[y * rowbytes:(y + 1) * rowbytes]


def _px(row: bytes, x: int) -> tuple[int, int, int]:
    return row[x * 3], row[x * 3 + 1], row[x * 3 + 2]


def _is_red(p):   return p[0] > 150 and p[2] < 100
def _is_blue(p):  return p[2] > 150 and p[0] < 100
def _is_black(p): return p[0] < 60 and p[1] < 60 and p[2] < 60


def _render(spec: dict, asset: str, tmp_path) -> str:
    out = str(tmp_path / "out.mp4")
    with patch.object(fb, "detect_video_encoder", return_value="libx264"):
        cmd = fb.build_command(spec, {"A": asset}, out, str(tmp_path))
    r = subprocess.run(cmd, cwd=str(tmp_path), capture_output=True, text=True, timeout=120)
    assert r.returncode == 0, r.stderr[-1200:]
    return out


def _clip_spec(w: int, h: int, clip_extra: dict) -> dict:
    return {
        "width": w, "height": h, "fps": 10, "durationSec": 1.0,
        "videoBitrateKbps": 4000,
        "tracks": [{"id": "t", "kind": "video", "muted": False}],
        "clips": [{
            "id": "c", "assetId": "A", "trackId": "t", "kind": "video",
            "startSec": 0, "inPointSec": 0, "outPointSec": 1.0, "speed": 1,
            "opacity": 1, "effects": [], "transform": {}, **clip_extra,
        }],
    }


@pytestmark_ffmpeg
def test_render_rotation_90_clockwise_matches_canvas(tmp_path):
    """Top-red/bottom-blue clip rotated +90° → red lands on the RIGHT (the
    canvas clockwise convention), bounding box 480x640 centred in 640x640."""
    src = str(tmp_path / "in.mp4")
    _gen(["-f", "lavfi", "-i", "color=red:s=320x120:d=1:r=10",
          "-f", "lavfi", "-i", "color=blue:s=320x120:d=1:r=10",
          "-filter_complex", "[0][1]vstack", "-pix_fmt", "yuv420p",
          "-c:v", "libx264", src])
    out = _render(_clip_spec(640, 640, {"transform": {"rotation": 90}}), src, tmp_path)

    row = _row(out, 5, 320, 640)        # middle row of a middle frame
    assert _is_red(_px(row, 480)), f"expected red right half, got {_px(row, 480)}"
    assert _is_blue(_px(row, 160)), f"expected blue left half, got {_px(row, 160)}"
    assert _is_black(_px(row, 40)), f"expected background outside 480px box, got {_px(row, 40)}"


@pytestmark_ffmpeg
def test_render_zoom_in_grows_the_clip_box(tmp_path):
    """PiP clip (scale 0.25) with zoom-in amount=1 must GROW on the frame
    (browser semantics) — not crop-zoom inside a fixed box (zoompan semantics).
    Box width: 160px at t≈0 → ~315px at the last frame."""
    src = str(tmp_path / "in.mp4")
    _gen(["-f", "lavfi", "-i", "color=red:s=320x240:d=1:r=10",
          "-pix_fmt", "yuv420p", "-c:v", "libx264", src])
    spec = _clip_spec(640, 480, {
        "transform": {"scale": 0.25},
        "effects": [{"type": "zoom-in", "params": {"amount": 1.0}}],
    })
    out = _render(spec, src, tmp_path)

    first = _row(out, 0, 240, 640)      # centre row, first frame: box ≈ x∈[240,400]
    assert _is_red(_px(first, 320))
    assert _is_red(_px(first, 250))
    assert _is_black(_px(first, 200)), f"box should be ~160px wide at t=0, got {_px(first, 200)}"

    last = _row(out, 9, 240, 640)       # last frame (t=0.9, z≈1.97): box ≈ x∈[162,478]
    assert _is_red(_px(last, 200)), f"box should have grown past x=200, got {_px(last, 200)}"
    assert _is_red(_px(last, 450))
    assert _is_black(_px(last, 100)), f"box must not cover x=100, got {_px(last, 100)}"


@pytestmark_ffmpeg
def test_render_fast_path_end_to_end(tmp_path):
    """A real single-clip export goes through the direct-transcode fast path
    (no -filter_complex) and still produces a correct file."""
    src = str(tmp_path / "in.mp4")
    _gen(["-f", "lavfi", "-i", "color=red:s=640x480:d=2:r=10",
          "-pix_fmt", "yuv420p", "-c:v", "libx264", src])
    spec = {
        "width": 640, "height": 480, "fps": 10, "durationSec": 2.0,
        "videoBitrateKbps": 4000,
        "tracks": [{"id": "t", "kind": "video", "muted": False}],
        "clips": [{
            "id": "c", "assetId": "A", "trackId": "t", "kind": "video",
            "startSec": 0, "inPointSec": 0, "outPointSec": 2.0, "speed": 1,
            "opacity": 1, "volume": 1, "hasAudio": False, "muted": False,
            "effects": [], "transform": {}, "adjust": {},
        }],
    }
    out = str(tmp_path / "out.mp4")
    with patch.object(fb, "detect_video_encoder", return_value="libx264"):
        cmd = fb.build_command(spec, {"A": src}, out, str(tmp_path))
    assert "-filter_complex" not in cmd, "single-clip export must take the fast path"
    r = subprocess.run(cmd, cwd=str(tmp_path), capture_output=True, text=True, timeout=120)
    assert r.returncode == 0, r.stderr[-1200:]

    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "stream=codec_name,width,height",
         "-of", "csv=p=0", out],
        capture_output=True, text=True,
    )
    assert probe.stdout.strip().startswith("h264,640,480")
    row = _row(out, 5, 240, 640)
    assert _is_red(_px(row, 320)), f"expected red centre, got {_px(row, 320)}"


@pytestmark_ffmpeg
def test_render_cuvid_decode_on_real_hardware(tmp_path):
    """End-to-end with the real cuvid GPU decoder (h264_cuvid → -resize → NVENC),
    skipped on machines without NVENC + the decoder. Proves the forced-decoder
    command really runs and decodes on the GPU."""
    if fb.detect_video_encoder() != "h264_nvenc" or "h264_cuvid" not in fb._available_cuvid():
        pytest.skip("needs NVENC + h264_cuvid")
    src = str(tmp_path / "in.mp4")
    _gen(["-f", "lavfi", "-i", "color=red:s=1280x720:d=2:r=10",
          "-pix_fmt", "yuv420p", "-c:v", "libx264", src])
    spec = {
        "width": 640, "height": 360, "fps": 10, "durationSec": 2.0,
        "videoBitrateKbps": 2000,
        "tracks": [{"id": "t", "kind": "video", "muted": False}],
        "clips": [{
            "id": "c", "assetId": "A", "trackId": "t", "kind": "video",
            "startSec": 0, "inPointSec": 0, "outPointSec": 2.0, "speed": 1,
            "opacity": 1, "volume": 1, "hasAudio": False, "muted": False,
            "effects": [], "transform": {}, "adjust": {},
        }],
    }
    out = str(tmp_path / "out.mp4")
    cmd = fb.build_command(spec, {"A": src}, out, str(tmp_path))
    assert "-c:v h264_cuvid" in " ".join(cmd), "expected the cuvid-decoder command"
    assert "-resize 640x360" in " ".join(cmd)
    r = subprocess.run(cmd, cwd=str(tmp_path), capture_output=True, text=True, timeout=120)
    assert r.returncode == 0, r.stderr[-1200:]
    row = _row(out, 5, 180, 640)
    assert _is_red(_px(row, 320)), f"expected red after GPU decode/scale, got {_px(row, 320)}"
