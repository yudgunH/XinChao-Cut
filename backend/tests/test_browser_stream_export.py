from __future__ import annotations

import os
import json
import threading
import time
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.routers import export as ex
from app.export import job as jobmod


@pytest.fixture(autouse=True)
def _isolated_stream_state(tmp_path, monkeypatch):
    manifests = tmp_path / "manifests"
    monkeypatch.setattr(ex, "_browser_stream_manifest_dir", lambda: str(manifests))
    ex._BROWSER_STREAMS.clear()
    ex._BROWSER_STREAM_COMPLETED.clear()
    ex._BROWSER_STREAM_CANCELLED.clear()
    jobmod._EXTERNAL_OUTPUT_RESERVATIONS.clear()
    jobmod.JOBS.clear()
    yield
    for job_id in list(jobmod.JOBS):
        jobmod.cancel_job(job_id)
    jobmod.JOBS.clear()
    ex.cleanup_active_browser_streams()
    ex._BROWSER_STREAM_COMPLETED.clear()
    ex._BROWSER_STREAM_CANCELLED.clear()
    jobmod._EXTERNAL_OUTPUT_RESERVATIONS.clear()


def _client() -> TestClient:
    app = FastAPI()
    app.include_router(ex.router)
    return TestClient(app)


def test_browser_stream_random_access_finalize_is_atomic(tmp_path):
    ex._BROWSER_STREAMS.clear()
    ex._BROWSER_STREAM_COMPLETED.clear()
    client = _client()
    started = client.post(
        "/export/browser-stream/start",
        json={
            "outputDir": str(tmp_path),
            "outputName": "browser",
            "estimatedBytes": 1024,
        },
    )
    assert started.status_code == 200, started.text
    data = started.json()
    stream_id = data["streamId"]
    final = data["path"]
    assert os.path.isfile(final) and os.path.getsize(final) == 0

    # Muxers append large media chunks, then patch headers at earlier offsets.
    assert client.put(
        f"/export/browser-stream/{stream_id}/chunk?position=4", content=b"EFGH"
    ).status_code == 200
    assert client.put(
        f"/export/browser-stream/{stream_id}/chunk?position=0", content=b"ABCD"
    ).status_code == 200
    done = client.post(
        f"/export/browser-stream/{stream_id}/finalize", json={"expectedSize": 8}
    )
    assert done.status_code == 200, done.text
    assert open(final, "rb").read() == b"ABCDEFGH"
    repeated = client.post(
        f"/export/browser-stream/{stream_id}/finalize", json={"expectedSize": 8}
    )
    assert repeated.status_code == 200
    assert repeated.json()["path"] == final
    assert not any(p.name.endswith(".uploading") for p in tmp_path.iterdir())


def test_browser_stream_preflight_validates_without_leaving_reservation(tmp_path):
    client = _client()
    checked = client.post(
        "/export/browser-stream/preflight",
        json={"outputDir": str(tmp_path), "outputName": "probe", "estimatedBytes": 100},
    )
    assert checked.status_code == 200, checked.text
    assert list(tmp_path.iterdir()) == []


def test_export_filename_is_bounded_and_avoids_windows_device_names():
    assert ex._safe_basename("CON") == "_CON.mp4"
    assert ex._safe_basename("name. ") == "name.mp4"
    bounded = ex._safe_basename("x" * 10_000)
    assert bounded.endswith(".mp4")
    assert len(bounded) <= ex._MAX_OUTPUT_STEM_CHARS + 4


def test_browser_stream_reserves_the_same_envelope_it_allows(monkeypatch, tmp_path):
    captured: list[int] = []
    monkeypatch.setattr(
        ex,
        "reserve_external_output",
        lambda _id, estimated, _free, _volume, **_kwargs: captured.append(estimated),
    )
    estimate = 1024 * 1024 * 1024

    ex._reserve_browser_stream_space("a" * 32, str(tmp_path / "out.mp4"), estimate)

    assert captured == [
        ex._browser_stream_payload_ceiling(estimate) + 128 * 1024 * 1024
    ]


def test_legacy_save_local_reserves_and_releases_destination_space(monkeypatch, tmp_path):
    reserved: list[int] = []
    released: list[str] = []
    monkeypatch.setattr(
        ex,
        "reserve_external_output",
        lambda _id, estimated, _free, _volume: reserved.append(estimated),
    )
    monkeypatch.setattr(ex, "update_external_output_written", lambda *_args: None)
    monkeypatch.setattr(ex, "release_external_output", lambda rid: released.append(rid))
    payload = b"rendered-video"

    response = _client().post(
        "/export/save-local",
        files={"file": ("out.mp4", payload, "video/mp4")},
        data={"outputDir": str(tmp_path), "outputName": "saved"},
    )

    assert response.status_code == 200, response.text
    assert (tmp_path / "saved.mp4").read_bytes() == payload
    assert reserved == [len(payload) + 128 * 1024 * 1024]
    assert len(released) == 1


def test_browser_stream_start_retry_is_idempotent(tmp_path):
    ex._BROWSER_STREAMS.clear()
    ex._BROWSER_STREAM_COMPLETED.clear()
    client = _client()
    payload = {
        "outputDir": str(tmp_path),
        "outputName": "retry",
        "estimatedBytes": 100,
        "requestId": "b" * 32,
    }

    first = client.post("/export/browser-stream/start", json=payload)
    repeated = client.post("/export/browser-stream/start", json=payload)

    assert first.status_code == 200, first.text
    assert repeated.status_code == 200, repeated.text
    assert repeated.json() == first.json()
    assert len(list(tmp_path.glob("*.mp4"))) == 1
    assert len([p for p in tmp_path.iterdir() if p.name.endswith(".uploading")]) == 1
    assert client.delete(
        f"/export/browser-stream/{first.json()['streamId']}"
    ).status_code == 200


def test_heartbeat_prevents_idle_stream_sweep(tmp_path):
    client = _client()
    data = client.post(
        "/export/browser-stream/start",
        json={"outputDir": str(tmp_path), "outputName": "alive", "estimatedBytes": 2},
    ).json()
    stream = ex._BROWSER_STREAMS[data["streamId"]]
    stream.last_activity = time.time() - 100

    assert client.post(
        f"/export/browser-stream/{data['streamId']}/heartbeat"
    ).status_code == 200
    assert ex.sweep_idle_browser_streams(max_idle_sec=10) == 0
    assert client.delete(
        f"/export/browser-stream/{data['streamId']}"
    ).status_code == 200


def test_heartbeat_without_progress_cannot_keep_stalled_stream_forever(tmp_path):
    client = _client()
    data = client.post(
        "/export/browser-stream/start",
        json={"outputDir": str(tmp_path), "outputName": "stalled", "estimatedBytes": 2},
    ).json()
    stream = ex._BROWSER_STREAMS[data["streamId"]]
    stream.last_progress_at = time.time() - 100

    assert client.post(
        f"/export/browser-stream/{data['streamId']}/heartbeat?writtenBytes=0"
    ).status_code == 200
    assert ex.sweep_idle_browser_streams(max_idle_sec=10, max_no_progress_sec=10) == 1
    assert data["streamId"] not in ex._BROWSER_STREAMS


def test_heartbeat_high_water_cannot_advance_durable_progress(tmp_path):
    client = _client()
    data = client.post(
        "/export/browser-stream/start",
        json={"outputDir": str(tmp_path), "outputName": "moving", "estimatedBytes": 2},
    ).json()
    stream = ex._BROWSER_STREAMS[data["streamId"]]
    stream.last_progress_at = time.time() - 100

    assert client.post(
        f"/export/browser-stream/{data['streamId']}/heartbeat?writtenBytes=1"
    ).status_code == 200
    assert stream.progress_bytes == 0
    assert ex.sweep_idle_browser_streams(max_idle_sec=10, max_no_progress_sec=10) == 1


def test_cancel_arriving_before_start_prevents_late_orphan(tmp_path):
    client = _client()
    stream_id = "c" * 32
    assert client.delete(f"/export/browser-stream/{stream_id}").status_code == 200
    started = client.post(
        "/export/browser-stream/start",
        json={
            "outputDir": str(tmp_path),
            "outputName": "too-late",
            "estimatedBytes": 2,
            "requestId": stream_id,
        },
    )
    assert started.status_code == 409
    assert not any(path.name.endswith(".uploading") for path in tmp_path.iterdir())


def test_overlapping_finalize_replay_accepts_already_published_file(tmp_path):
    ex._BROWSER_STREAMS.clear()
    ex._BROWSER_STREAM_COMPLETED.clear()
    client = _client()
    data = client.post(
        "/export/browser-stream/start",
        json={"outputDir": str(tmp_path), "outputName": "overlap", "estimatedBytes": 2},
    ).json()
    stream_id = data["streamId"]
    assert client.put(
        f"/export/browser-stream/{stream_id}/chunk?position=0", content=b"OK"
    ).status_code == 200

    # State during the tiny interval after the first finalize publishes the file
    # but before it records the completed tombstone.
    stream = ex._BROWSER_STREAMS[stream_id]
    with stream.lock:
        stream.closed = True
        os.replace(stream.temp_path, stream.final_path)

    replay = client.post(
        f"/export/browser-stream/{stream_id}/finalize", json={"expectedSize": 2}
    )
    assert replay.status_code == 200, replay.text
    assert replay.json()["path"] == data["path"]
    ex._BROWSER_STREAMS.pop(stream_id, None)
    ex._remove_browser_stream_manifest(stream_id)


def test_browser_stream_cancel_removes_temp_and_reservation(tmp_path):
    ex._BROWSER_STREAMS.clear()
    ex._BROWSER_STREAM_COMPLETED.clear()
    client = _client()
    data = client.post(
        "/export/browser-stream/start",
        json={"outputDir": str(tmp_path), "outputName": "cancel", "estimatedBytes": 100},
    ).json()
    stream_id = data["streamId"]
    assert client.put(
        f"/export/browser-stream/{stream_id}/chunk?position=0", content=b"partial"
    ).status_code == 200

    assert client.delete(f"/export/browser-stream/{stream_id}").status_code == 200
    assert not os.path.exists(data["path"])
    assert not any(p.name.endswith(".uploading") for p in tmp_path.iterdir())


def test_browser_stream_rejects_sparse_file_even_when_size_matches(tmp_path):
    ex._BROWSER_STREAMS.clear()
    ex._BROWSER_STREAM_COMPLETED.clear()
    client = _client()
    data = client.post(
        "/export/browser-stream/start",
        json={"outputDir": str(tmp_path), "outputName": "sparse", "estimatedBytes": 100},
    ).json()
    stream_id = data["streamId"]
    assert client.put(
        f"/export/browser-stream/{stream_id}/chunk?position=4", content=b"EFGH"
    ).status_code == 200
    assert jobmod._EXTERNAL_OUTPUT_RESERVATIONS[stream_id].written_bytes == 4

    done = client.post(
        f"/export/browser-stream/{stream_id}/finalize", json={"expectedSize": 8}
    )
    assert done.status_code == 400
    assert "incomplete byte coverage" in done.text
    assert not os.path.exists(data["path"])


def test_stale_stream_cleanup_only_removes_owned_pattern(tmp_path):
    stale = tmp_path / ".old.mp4.browser-deadbeef.uploading"
    reservation = tmp_path / "old.mp4"
    unrelated = tmp_path / "keep.uploading"
    stale.write_bytes(b"partial")
    reservation.write_bytes(b"")
    unrelated.write_bytes(b"keep")
    old = time.time() - ex._BROWSER_STREAM_STALE_SEC - 10
    os.utime(stale, (old, old))
    os.utime(reservation, (old, old))

    ex._cleanup_stale_browser_streams(str(tmp_path))

    assert not stale.exists()
    assert not reservation.exists()
    assert unrelated.read_bytes() == b"keep"


def test_restart_manifest_recovers_orphan_temp_and_reservation(tmp_path, monkeypatch):
    manifests = tmp_path / "manifests"
    monkeypatch.setattr(ex, "_browser_stream_manifest_dir", lambda: str(manifests))
    stream_id = "a" * 32
    final = tmp_path / "recovered.mp4"
    temp = tmp_path / f".recovered.mp4.browser-{stream_id}.uploading"
    final.write_bytes(b"")
    temp.write_bytes(b"partial")
    stream = ex._BrowserStream(stream_id, str(final), str(temp), 100)
    ex._write_browser_stream_manifest(stream)

    assert ex.cleanup_orphaned_browser_stream_manifests() == 1
    assert not final.exists()
    assert not temp.exists()
    assert not (manifests / f"{stream_id}.json").exists()


def test_restart_restores_active_ranges_and_continues_upload(tmp_path):
    client = _client()
    request_id = "d" * 32
    payload = {
        "outputDir": str(tmp_path),
        "outputName": "resumed",
        "estimatedBytes": 8,
        "requestId": request_id,
    }
    started = client.post("/export/browser-stream/start", json=payload)
    assert started.status_code == 200, started.text
    assert client.put(
        f"/export/browser-stream/{request_id}/chunk?position=0", content=b"ABCD"
    ).status_code == 200

    # Simulate process memory loss while retaining the durable manifest/temp.
    ex._BROWSER_STREAMS.clear()
    jobmod._EXTERNAL_OUTPUT_RESERVATIONS.clear()

    assert ex.cleanup_orphaned_browser_stream_manifests() == 0
    restored = ex._BROWSER_STREAMS[request_id]
    assert restored.written_ranges == [(0, 4)]
    assert jobmod._EXTERNAL_OUTPUT_RESERVATIONS[request_id].written_bytes == 4

    repeated = client.post("/export/browser-stream/start", json=payload)
    assert repeated.status_code == 200
    assert repeated.json() == started.json()
    assert client.put(
        f"/export/browser-stream/{request_id}/chunk?position=4", content=b"EFGH"
    ).status_code == 200
    done = client.post(
        f"/export/browser-stream/{request_id}/finalize", json={"expectedSize": 8}
    )
    assert done.status_code == 200, done.text
    assert (tmp_path / "resumed.mp4").read_bytes() == b"ABCDEFGH"


def test_every_acknowledged_chunk_survives_immediate_backend_restart(tmp_path):
    """ACK must cover bytes *and* coverage metadata, not only the first chunk."""
    client = _client()
    request_id = "1" * 32
    payload = {
        "outputDir": str(tmp_path),
        "outputName": "acked",
        "estimatedBytes": 12,
        "requestId": request_id,
    }
    assert client.post("/export/browser-stream/start", json=payload).status_code == 200
    assert client.put(
        f"/export/browser-stream/{request_id}/chunk?position=0", content=b"AAAA"
    ).status_code == 200
    # This second write occurs immediately and is much smaller than the former
    # 256 MiB checkpoint interval. It still returned 200, so it must be durable.
    assert client.put(
        f"/export/browser-stream/{request_id}/chunk?position=4", content=b"BBBB"
    ).status_code == 200

    ex._BROWSER_STREAMS.clear()
    jobmod._EXTERNAL_OUTPUT_RESERVATIONS.clear()
    assert ex.cleanup_orphaned_browser_stream_manifests() == 0
    assert ex._BROWSER_STREAMS[request_id].written_ranges == [(0, 8)]

    assert client.put(
        f"/export/browser-stream/{request_id}/chunk?position=8", content=b"CCCC"
    ).status_code == 200
    done = client.post(
        f"/export/browser-stream/{request_id}/finalize", json={"expectedSize": 12}
    )
    assert done.status_code == 200, done.text
    assert (tmp_path / "acked.mp4").read_bytes() == b"AAAABBBBCCCC"


def test_manifest_roundtrip_preserves_ranges_beyond_two_gib(tmp_path, monkeypatch):
    """Python/JSON/Pydantic path must retain 64-bit media offsets exactly."""
    request_id = "2" * 32
    final = tmp_path / "large.mp4"
    temp = tmp_path / f".large.mp4.browser-{request_id}.uploading"
    final.write_bytes(b"")
    temp.write_bytes(b"x")
    logical_size = 3 * 1024**3 + 17
    stream = ex._BrowserStream(
        request_id,
        str(final),
        str(temp),
        logical_size,
        written_ranges=[(0, logical_size)],
        progress_bytes=logical_size,
    )
    ex._write_browser_stream_manifest(stream)
    real_getsize = os.path.getsize

    def logical_getsize(path):
        if os.path.normcase(os.path.abspath(path)) == os.path.normcase(str(temp)):
            return logical_size
        return real_getsize(path)

    monkeypatch.setattr(ex.os.path, "getsize", logical_getsize)
    monkeypatch.setattr(ex, "_reserve_browser_stream_space", lambda *_args, **_kwargs: None)

    assert ex.cleanup_orphaned_browser_stream_manifests() == 0
    restored = ex._BROWSER_STREAMS[request_id]
    assert restored.estimated_bytes == logical_size
    assert restored.progress_bytes == logical_size
    assert restored.written_ranges == [(0, logical_size)]


def test_restart_admission_credits_already_written_bytes(tmp_path, monkeypatch):
    client = _client()
    request_id = "e" * 32
    estimate = 8
    payload = {
        "outputDir": str(tmp_path),
        "outputName": "credited",
        "estimatedBytes": estimate,
        "requestId": request_id,
    }
    assert client.post("/export/browser-stream/start", json=payload).status_code == 200
    assert client.put(
        f"/export/browser-stream/{request_id}/chunk?position=0", content=b"ABCD"
    ).status_code == 200
    ex._BROWSER_STREAMS.clear()
    jobmod._EXTERNAL_OUTPUT_RESERVATIONS.clear()
    required = ex._browser_stream_payload_ceiling(estimate) + 128 * 1024 * 1024
    monkeypatch.setattr(ex, "_free_bytes_on_volume", lambda _path: required - 4)

    assert ex.cleanup_orphaned_browser_stream_manifests() == 0

    reservation = jobmod._EXTERNAL_OUTPUT_RESERVATIONS[request_id]
    assert reservation.estimated_bytes == required
    assert reservation.written_bytes == 4
    assert request_id in ex._BROWSER_STREAMS


def test_restart_insufficient_space_preserves_valid_partial(tmp_path, monkeypatch):
    client = _client()
    request_id = "f" * 32
    payload = {
        "outputDir": str(tmp_path),
        "outputName": "deferred",
        "estimatedBytes": 8,
        "requestId": request_id,
    }
    started = client.post("/export/browser-stream/start", json=payload).json()
    assert client.put(
        f"/export/browser-stream/{request_id}/chunk?position=0", content=b"ABCD"
    ).status_code == 200
    temp_path = ex._BROWSER_STREAMS[request_id].temp_path
    manifest = ex._browser_stream_manifest_path(request_id)
    ex._BROWSER_STREAMS.clear()
    jobmod._EXTERNAL_OUTPUT_RESERVATIONS.clear()
    monkeypatch.setattr(ex, "_free_bytes_on_volume", lambda _path: 0)

    assert ex.cleanup_orphaned_browser_stream_manifests() == 0

    assert os.path.isfile(temp_path)
    assert open(temp_path, "rb").read() == b"ABCD"
    assert os.path.isfile(manifest)
    assert os.path.isfile(started["path"])
    assert request_id not in ex._BROWSER_STREAMS


def test_completed_manifest_restores_idempotent_finalize_after_restart(tmp_path):
    client = _client()
    data = client.post(
        "/export/browser-stream/start",
        json={"outputDir": str(tmp_path), "outputName": "durable", "estimatedBytes": 2},
    ).json()
    stream_id = data["streamId"]
    assert client.put(
        f"/export/browser-stream/{stream_id}/chunk?position=0", content=b"OK"
    ).status_code == 200
    assert client.post(
        f"/export/browser-stream/{stream_id}/finalize", json={"expectedSize": 2}
    ).status_code == 200

    ex._BROWSER_STREAM_COMPLETED.clear()
    assert ex.cleanup_orphaned_browser_stream_manifests() == 0
    replay = client.post(
        f"/export/browser-stream/{stream_id}/finalize", json={"expectedSize": 2}
    )
    assert replay.status_code == 200, replay.text
    assert replay.json()["path"] == data["path"]


def test_restart_does_not_resurrect_stream_already_transferred_to_hybrid_job(
    tmp_path, monkeypatch
):
    request_id = "3" * 32
    final = tmp_path / "hybrid.mp4"
    temp = tmp_path / f".hybrid.mp4.browser-{request_id}.uploading"
    final.write_bytes(b"")
    temp.write_bytes(b"video-only")
    stream = ex._BrowserStream(
        request_id,
        str(final),
        str(temp),
        len(b"video-only"),
        written_ranges=[(0, len(b"video-only"))],
    )
    ex._write_browser_stream_manifest(stream)
    monkeypatch.setattr(ex, "persisted_job_status", lambda _id: "setup")

    assert ex.cleanup_orphaned_browser_stream_manifests() == 1
    assert request_id not in ex._BROWSER_STREAMS
    assert not temp.exists()
    assert not final.exists()
    assert not os.path.exists(ex._browser_stream_manifest_path(request_id))


def test_restart_preserves_stream_when_job_db_ownership_is_unknown(tmp_path, monkeypatch):
    request_id = "4" * 32
    final = tmp_path / "uncertain.mp4"
    temp = tmp_path / f".uncertain.mp4.browser-{request_id}.uploading"
    final.write_bytes(b"")
    temp.write_bytes(b"partial")
    stream = ex._BrowserStream(
        request_id,
        str(final),
        str(temp),
        100,
        written_ranges=[(0, len(b"partial"))],
    )
    ex._write_browser_stream_manifest(stream)

    def unavailable(_id):
        raise OSError("jobs db unavailable")

    monkeypatch.setattr(ex, "persisted_job_status", unavailable)

    assert ex.cleanup_orphaned_browser_stream_manifests() == 0
    assert temp.read_bytes() == b"partial"
    assert final.exists()
    assert os.path.exists(ex._browser_stream_manifest_path(request_id))
    assert request_id not in ex._BROWSER_STREAMS


def test_create_job_persistence_failure_does_not_publish_ghost(monkeypatch):
    request_id = "5" * 32
    monkeypatch.setattr(
        jobmod,
        "persist_job",
        lambda **_kwargs: (_ for _ in ()).throw(OSError("db write failed")),
    )

    with pytest.raises(OSError, match="db write failed"):
        jobmod.create_job(1, "out.mp4", status="setup", job_id=request_id)

    assert request_id not in jobmod.JOBS


def test_hybrid_finalize_transfers_stream_to_cancellable_export_job(
    tmp_path, monkeypatch
):
    persisted: list[dict] = []
    monkeypatch.setattr(jobmod, "persist_job", lambda **kwargs: persisted.append(kwargs))
    monkeypatch.setattr(
        ex, "get_settings", lambda: type("Settings", (), {"work_dir": str(tmp_path / "work")})()
    )
    monkeypatch.setattr(ex, "_resolve_spec_assets", lambda *_args, **_kwargs: {})
    # Keep the test at the ownership boundary; ffmpeg command execution has its
    # own focused tests. The real daemon thread exits immediately here.
    received_spec = {}
    received = threading.Event()

    def capture_setup(_job, spec, *_args):
        received_spec.update(spec)
        received.set()

    monkeypatch.setattr(ex, "_setup_hybrid_export_job", capture_setup)
    client = _client()
    request_id = "9" * 32
    hybrid_spec = {
        "width": 1920,
        "height": 1080,
        "fps": 30,
        "durationSec": 5,
        "videoBitrateKbps": 8000,
        "tracks": [{"id": "audio", "muted": False}],
        "clips": [{
            "id": "a1", "trackId": "audio", "kind": "audio",
            "assetId": "hash", "startSec": 0, "inPointSec": 0,
            "outPointSec": 5, "speed": 1, "hasAudio": True,
        }],
    }
    started = client.post(
        "/export/browser-stream/start",
        json={
            "outputDir": str(tmp_path),
            "outputName": "hybrid",
            "estimatedBytes": 8,
            "requestId": request_id,
            "hybridSpec": hybrid_spec,
        },
    )
    assert started.status_code == 200, started.text
    assert client.put(
        f"/export/browser-stream/{request_id}/chunk?position=0", content=b"VIDEO"
    ).status_code == 200

    done = client.post(
        f"/export/browser-stream/{request_id}/finalize",
        json={"expectedSize": 5, "videoCodec": "h264"},
    )
    assert done.status_code == 200, done.text
    assert done.json()["jobId"] == request_id
    job = jobmod.JOBS[request_id]
    assert job.status == "setup"
    assert job.external_reservation_id == request_id
    first_extra = json.loads(persisted[0]["extra"])
    assert first_extra["job_dir"] == job.job_dir
    assert first_extra["temp_path"] == job.temp_path
    assert first_extra["reserved_out"] is True
    assert first_extra["external_reservation_id"] == request_id
    assert first_extra["cleanup_paths"] == job.cleanup_paths
    assert received.wait(timeout=1)
    assert received_spec["videoCodec"] == "h264"
    assert os.path.isfile(job.cleanup_paths[0])
    browser_scratch = job.cleanup_paths[0]
    assert os.path.getsize(done.json()["path"]) == 0

    assert client.delete(f"/export/browser-stream/{request_id}").status_code == 200
    assert job.status == "cancelled"
    assert not os.path.exists(browser_scratch)
    assert request_id not in jobmod._EXTERNAL_OUTPUT_RESERVATIONS


def test_hybrid_manifest_keeps_large_spec_in_immutable_sidecar(tmp_path, monkeypatch):
    monkeypatch.setattr(ex, "_resolve_spec_assets", lambda *_args, **_kwargs: {})
    client = _client()
    request_id = "8" * 32
    spec = {
        "width": 1920,
        "height": 1080,
        "fps": 30,
        "durationSec": 5,
        "videoBitrateKbps": 8000,
        "tracks": [{"id": "audio", "muted": False}],
        "clips": [{
            "id": "a1", "trackId": "audio", "kind": "audio",
            "assetId": "hash", "startSec": 0, "inPointSec": 0,
            "outPointSec": 5, "speed": 1, "volume": 1,
        }],
    }
    started = client.post(
        "/export/browser-stream/start",
        json={
            "outputDir": str(tmp_path), "outputName": "sidecar",
            "estimatedBytes": 8, "requestId": request_id, "hybridSpec": spec,
        },
    )
    assert started.status_code == 200, started.text
    manifest_path = ex._browser_stream_manifest_path(request_id)
    sidecar_path = ex._browser_stream_hybrid_spec_path(request_id)
    manifest = json.loads(open(manifest_path, encoding="utf-8").read())
    assert "hybridSpec" not in manifest
    assert manifest["hybridSpecFile"] == f"{request_id}.hybrid.json"
    assert json.loads(open(sidecar_path, encoding="utf-8").read())["clips"][0]["id"] == "a1"

    assert client.put(
        f"/export/browser-stream/{request_id}/chunk?position=0", content=b"A"
    ).status_code == 200
    # A hot checkpoint updates only the small coverage manifest; the immutable
    # sidecar remains present and unchanged.
    assert os.path.getsize(manifest_path) < os.path.getsize(sidecar_path) + 1024
    assert client.delete(f"/export/browser-stream/{request_id}").status_code == 200
    assert not os.path.exists(sidecar_path)


def test_cancel_waits_for_finalize_transfer_then_cancels_job(tmp_path, monkeypatch):
    request_id = "7" * 32
    final = tmp_path / "final.mp4"
    temp = tmp_path / "uploading.mp4"
    final.write_bytes(b"")
    temp.write_bytes(b"VIDEO")
    stream = ex._BrowserStream(
        request_id, str(final), str(temp), 5,
        hybrid_spec={"durationSec": 1},
        written_ranges=[(0, 5)], progress_bytes=5,
    )
    ex._BROWSER_STREAMS[request_id] = stream
    entered = threading.Event()
    release = threading.Event()
    transferred = SimpleNamespace(id=request_id, out_path=str(final))
    job_visible = False
    cancelled: list[str] = []

    def queue(_stream, _size):
        nonlocal job_visible
        entered.set()
        assert release.wait(3)
        job_visible = True
        return transferred

    monkeypatch.setattr(ex, "_queue_hybrid_export", queue)
    monkeypatch.setattr(ex, "get_job", lambda _id: transferred if job_visible else None)
    monkeypatch.setattr(ex, "cancel_job", lambda job_id: cancelled.append(job_id) or True)
    monkeypatch.setattr(ex, "_remove_browser_stream_manifest", lambda _id: None)

    errors: list[BaseException] = []
    def run(call):
        try:
            call()
        except BaseException as exc:  # noqa: BLE001 - surface thread failures
            errors.append(exc)

    finalize_thread = threading.Thread(
        target=lambda: run(lambda: ex.browser_stream_finalize(
            request_id, ex.BrowserStreamFinalize(expectedSize=5)
        )),
    )
    cancel_thread = threading.Thread(
        target=lambda: run(lambda: ex.browser_stream_cancel(request_id)),
    )
    finalize_thread.start()
    assert entered.wait(3)
    cancel_thread.start()
    time.sleep(0.05)
    release.set()
    finalize_thread.join(3)
    cancel_thread.join(3)

    assert not errors
    assert cancelled == [request_id]
    assert temp.exists(), "the Job owns browser input after transfer"
