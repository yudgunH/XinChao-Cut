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


# ── build_command: encoder-specific flags ───────────────────────────────────

_SPEC = {
    "width": 1920, "height": 1080, "fps": 30, "durationSec": 5,
    "videoBitrateKbps": 8000, "tracks": [], "clips": [],
}


def test_build_command_nvenc_adds_preset_and_rc(tmp_path):
    with patch.object(fb, "detect_video_encoder", return_value="h264_nvenc"):
        cmd = fb.build_command(_SPEC, {}, str(tmp_path / "out.mp4"), str(tmp_path))
    s = " ".join(cmd)
    assert "-c:v h264_nvenc" in s
    assert "-preset p4" in s and "-rc vbr" in s


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
    assert "boxblur=" in graph
    assert "enable='between(t,1.0000,3.0000)'" in graph


def test_blur_sticker_renders_below_captions(tmp_path):
    spec = _add_blur_sticker(_spec_with_caption(hasAudio=False))
    with patch.object(fb, "detect_video_encoder", return_value="libx264"), \
         patch.object(fb, "cuvid_decoder_for", return_value=None), \
         patch.object(fb, "_has_audio_stream", return_value=False):
        cmd = fb.build_command(spec, {"A": "/in.mp4"}, str(tmp_path / "out.mp4"), str(tmp_path))
    graph = cmd[cmd.index("-filter_complex") + 1]
    assert graph.index("boxblur=") < graph.index("ass=captions.ass")


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


def _build_general(spec, *, probe_audio):
    """Build via the general path (spec must have a text clip), with the source
    audio-stream probe stubbed."""
    with patch.object(fb, "detect_video_encoder", return_value="libx264"), \
         patch.object(fb, "cuvid_decoder_for", return_value=None), \
         patch.object(fb, "_has_audio_stream", return_value=probe_audio), \
         patch("app.ffmpeg_utils.probe", return_value={"width": 1920, "height": 1080}):
        return fb.build_command(spec, {"A": "/in.mp4"}, "/out.mp4", ".")


def _spec_with_caption(**clip_over):
    s = _single_clip_spec(**clip_over)
    s["tracks"].append({"id": "tt", "kind": "text", "muted": False})
    s["clips"].append({
        "id": "tx", "trackId": "tt", "kind": "text", "startSec": 0, "durationSec": 10.0,
        "inPointSec": 0, "outPointSec": 10.0, "speed": 1, "textData": {"content": "hi"},
    })
    return s


def test_audio_included_when_source_has_stream_despite_false_flag():
    # hasAudio=False (frontend waveform missed) but the source HAS audio → keep it.
    cmd = _build_general(_spec_with_caption(hasAudio=False), probe_audio=True)
    assert "[0:a]" in " ".join(cmd) and "-c:a" in cmd


def test_audio_dropped_when_source_truly_silent():
    cmd = _build_general(_spec_with_caption(hasAudio=False), probe_audio=False)
    assert "[0:a]" not in " ".join(cmd) and "-c:a" not in cmd


def test_audio_dropped_for_muted_clip_even_with_stream():
    cmd = _build_general(_spec_with_caption(hasAudio=True, muted=True), probe_audio=True)
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


def test_export_after_split_with_caption_stays_small():
    # The reported crash: split + burned captions OOM'd a deep filtergraph. After
    # the merge it's one input, one overlay, no split/amix.
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
        cmd = fb.build_command(spec, {"A": "/in.mp4"}, "/out.mp4", ".")
    s = " ".join(cmd)
    assert cmd.count("-i") == 1
    assert "split=" not in s and "amix" not in s
    assert s.count("overlay=") == 1 and "ass=" in s


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
