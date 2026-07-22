import json

from app import ffmpeg_utils


def test_probe_reads_only_first_hdr_frame_for_static_metadata(monkeypatch):
    stream = {
        "streams": [{
            "codec_type": "video",
            "codec_name": "hevc",
            "width": 1920,
            "height": 1080,
            "avg_frame_rate": "30/1",
            "pix_fmt": "yuv420p10le",
            "color_primaries": "bt2020",
            "color_transfer": "smpte2084",
            "color_space": "bt2020nc",
        }],
        "format": {"duration": "10"},
    }
    frame = {
        "frames": [{"side_data_list": [
            {"side_data_type": "Mastering display metadata", "red_x": "1/2"},
            {
                "side_data_type": "Content light level metadata",
                "max_content": 1000,
                "max_average": 400,
            },
        ]}],
    }
    calls: list[list[str]] = []

    def fake_run(cmd, **_kwargs):
        calls.append(cmd)
        return json.dumps(stream if len(calls) == 1 else frame)

    monkeypatch.setattr(ffmpeg_utils, "_run", fake_run)
    meta = ffmpeg_utils.probe("hdr.mp4")

    assert meta["masteringDisplay"]["red_x"] == "1/2"
    assert meta["contentLightLevel"]["max_content"] == 1000
    assert len(calls) == 2
    assert calls[1][calls[1].index("-read_intervals") + 1] == "%+#1"


def test_probe_does_not_decode_a_frame_for_sdr(monkeypatch):
    stream = {
        "streams": [{
            "codec_type": "video",
            "width": 1280,
            "height": 720,
            "avg_frame_rate": "30/1",
            "pix_fmt": "yuv420p",
            "color_primaries": "bt709",
            "color_transfer": "bt709",
            "color_space": "bt709",
        }],
        "format": {"duration": "1"},
    }
    calls = 0

    def fake_run(_cmd, **_kwargs):
        nonlocal calls
        calls += 1
        return json.dumps(stream)

    monkeypatch.setattr(ffmpeg_utils, "_run", fake_run)
    meta = ffmpeg_utils.probe("sdr.mp4")

    assert calls == 1
    assert meta["masteringDisplay"] is None
    assert meta["contentLightLevel"] is None
