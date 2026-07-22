"""S11 — export job integrity (F13 input lease/materialize, F14 O_EXCL, F15 setup)."""
from __future__ import annotations

import errno
import json
import os
import signal
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import pytest

from app.export import integrity as integ
from app.export import job as J
from app.routers import assets as assets_mod
from app.routers import export as ex


def test_posix_tree_kill_escalates_when_child_survives_leader(monkeypatch):
    calls: list[tuple[int, int]] = []

    class FakeProc:
        pid = 4242

        @staticmethod
        def wait(timeout=None):
            return 0  # leader exited, but its process group is still alive

    monkeypatch.setattr(J, "_KILL_USES_WINDOWS", False)
    monkeypatch.setattr(J.signal, "SIGKILL", 9, raising=False)
    monkeypatch.setattr(
        J.os,
        "killpg",
        lambda pgid, sig: calls.append((pgid, sig)),
        raising=False,
    )

    J._kill_proc_tree(FakeProc())

    assert calls == [
        (4242, signal.SIGTERM),
        (4242, 0),
        (4242, 9),
    ]


def test_windows_export_tree_kill_uses_native_fallback_supervisor(monkeypatch):
    captured: list[object] = []

    class FakeProc:
        pid = 31337

    monkeypatch.setattr(J, "_KILL_USES_WINDOWS", True)
    from app import process_runner

    monkeypatch.setattr(process_runner, "kill_process_tree", captured.append)
    proc = FakeProc()

    J._kill_proc_tree(proc)

    assert captured == [proc]


def test_windows_chunk_stage_falls_back_when_taskkill_is_denied(monkeypatch):
    from app.export import chunk_runner

    class FakeProc:
        pid = 31338

        def __init__(self):
            self.alive = True
            self.killed = 0
            self.waited: list[float | None] = []

        def poll(self):
            return None if self.alive else 1

        def kill(self):
            self.killed += 1
            self.alive = False

        def wait(self, timeout=None):
            self.waited.append(timeout)
            return 1

    monkeypatch.setattr(chunk_runner, "_IS_WINDOWS", True)
    monkeypatch.setattr(
        chunk_runner.subprocess,
        "run",
        lambda *_a, **_kw: chunk_runner.subprocess.CompletedProcess([], 1),
    )
    proc = FakeProc()

    chunk_runner._kill_stage(proc)

    assert proc.killed == 1
    assert proc.waited == [2]


@pytest.fixture(autouse=True)
def _clean_leases(tmp_path, monkeypatch):
    integ.reset_leases_for_tests()
    # Point work_dir at tmp so job dirs / assets never touch real data.
    monkeypatch.setenv("XINCHAO_WORK_DIR", str(tmp_path / "work"))
    from app.config import get_settings
    get_settings.cache_clear()
    yield
    integ.reset_leases_for_tests()
    get_settings.cache_clear()


def test_reserve_output_two_concurrent_same_name(tmp_path):
    d = str(tmp_path / "out")
    os.makedirs(d, exist_ok=True)
    paths: list[str] = []
    lock = threading.Lock()

    def one() -> None:
        p = integ.reserve_output_exclusive(d, "clip.mp4")
        with lock:
            paths.append(p)

    with ThreadPoolExecutor(max_workers=8) as pool:
        futs = [pool.submit(one) for _ in range(8)]
        for f in as_completed(futs):
            f.result(timeout=5)

    assert len(paths) == 8
    assert len(set(paths)) == 8
    for p in paths:
        assert os.path.isfile(p)


def test_reserve_output_fails_immediately_for_non_collision_os_error(tmp_path, monkeypatch):
    calls = 0

    def denied(*_args, **_kwargs):
        nonlocal calls
        calls += 1
        raise PermissionError("read-only destination")

    monkeypatch.setattr(integ.os, "open", denied)
    with pytest.raises(PermissionError, match="read-only"):
        integ.reserve_output_exclusive(str(tmp_path), "clip.mp4")
    assert calls == 1


def test_reserve_output_uses_bounded_random_fallback_after_dense_collisions(tmp_path):
    for n in range(integ._MAX_NUMBERED_NAME_PROBES):
        name = "clip.mp4" if n == 0 else f"clip({n}).mp4"
        (tmp_path / name).write_bytes(b"old")

    path = integ.reserve_output_exclusive(str(tmp_path), "clip.mp4")

    assert os.path.isfile(path)
    assert os.path.basename(path).startswith("clip-")


def test_resolve_output_path_concurrent_unique(tmp_path):
    d = str(tmp_path / "exports")
    results = []

    def one():
        results.append(ex._resolve_output_path(d, "day"))

    threads = [threading.Thread(target=one) for _ in range(6)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=5)
    assert len(results) == 6
    assert len(set(results)) == 6


def test_hardlink_fallback_to_copy(tmp_path, monkeypatch):
    src = tmp_path / "src.bin"
    src.write_bytes(b"hello-asset")
    dest = tmp_path / "job" / "inputs" / "a.bin"

    def boom(*_a, **_k):
        raise OSError("cross-device link not permitted")

    monkeypatch.setattr(os, "link", boom)
    res = integ.materialize_input(str(src), str(dest))
    assert res.method == "copy"
    assert Path(res.local_path).read_bytes() == b"hello-asset"


def test_hardlink_when_supported(tmp_path):
    src = tmp_path / "src.bin"
    src.write_bytes(b"same-inode")
    dest = tmp_path / "dst.bin"
    res = integ.materialize_input(str(src), str(dest))
    assert res.method in ("hardlink", "copy")  # CI FS may not allow links
    assert Path(res.local_path).read_bytes() == b"same-inode"
    if res.method == "hardlink":
        assert os.stat(src).st_ino == os.stat(dest).st_ino


def test_lease_blocks_asset_cleanup(tmp_path, monkeypatch):
    from app.config import get_settings
    s = get_settings()
    # Force aggressive cleanup.
    object.__setattr__(s, "assets_ttl_days", 0)
    object.__setattr__(s, "assets_quota_mb", 1)  # 1 MiB cap

    assets_dir = Path(s.work_dir) / "assets"
    assets_dir.mkdir(parents=True, exist_ok=True)
    # hash-like names (two large-ish files so quota must try to evict)
    p1 = assets_dir / (("a" * 32) + ".mp4")
    p2 = assets_dir / (("b" * 32) + ".mp4")
    p1.write_bytes(b"x" * (600 * 1024))
    p2.write_bytes(b"y" * (600 * 1024))
    # Make p1 older
    os.utime(p1, (1, 1))
    os.utime(p2, (1000, 1000))

    integ.lease_paths([str(p1)])
    assets_mod.cleanup_assets()
    assert p1.is_file(), "leased input must survive cleanup while job waits"
    # p2 may or may not be evicted depending on total vs quota — not asserted.
    integ.release_paths([str(p1)])
    # Second cleanup after release is free to delete p1 if still over quota.
    assets_mod.cleanup_assets()
    # Idempotent release
    integ.release_paths([str(p1)])
    integ.release_paths([str(p1)])


def test_cleanup_job_fs_idempotent_twice(tmp_path):
    src = tmp_path / "asset.mp4"
    src.write_bytes(b"data")
    leased = integ.lease_paths([str(src)])
    job = J.Job(
        id="j1",
        duration=1.0,
        out_path=str(tmp_path / "out.mp4"),
        temp_path=str(tmp_path / "render.part.mp4"),
        leased_paths=list(leased),
        reserved_out=True,
    )
    Path(job.temp_path).write_bytes(b"partial")
    Path(job.out_path).write_bytes(b"")  # reservation
    integ.cleanup_job_fs(job, success=False)
    integ.cleanup_job_fs(job, success=False)  # must not raise
    assert not Path(job.temp_path).exists() if job.temp_path else True
    assert integ.lease_count(str(src)) == 0


def test_publish_atomic_and_fail_leaves_no_false_final(tmp_path):
    final = tmp_path / "final.mp4"
    final.write_bytes(b"")  # reservation
    temp = tmp_path / "render.part.mp4"
    temp.write_bytes(b"GOOD-VIDEO")
    integ.publish_atomic(str(temp), str(final))
    assert final.read_bytes() == b"GOOD-VIDEO"
    assert not temp.exists()


def test_publish_atomic_cross_device_fallback(tmp_path, monkeypatch):
    final = tmp_path / "final.mp4"
    final.write_bytes(b"")  # exclusive reservation
    temp = tmp_path / "render.part.mp4"
    temp.write_bytes(b"CROSS-VOLUME-VIDEO")

    real_replace = os.replace
    calls = 0

    def replace_once_exdev(src, dst):
        nonlocal calls
        calls += 1
        if calls == 1:
            raise OSError(errno.EXDEV, "cross-device link")
        return real_replace(src, dst)

    monkeypatch.setattr(integ.os, "replace", replace_once_exdev)
    integ.publish_atomic(str(temp), str(final))

    assert calls == 2
    assert final.read_bytes() == b"CROSS-VOLUME-VIDEO"
    assert not temp.exists()
    assert not list(tmp_path.glob("*.copy-*.part"))


def test_fail_setup_no_ghost_running(tmp_path, monkeypatch):
    from app.config import get_settings
    get_settings.cache_clear()
    job = J.create_job(5.0, out_path="", status="setup")
    job.job_dir = str(tmp_path / "exports" / job.id)
    os.makedirs(job.job_dir, exist_ok=True)
    job.out_path = str(tmp_path / "user" / "out.mp4")
    os.makedirs(os.path.dirname(job.out_path), exist_ok=True)
    open(job.out_path, "wb").close()
    job.reserved_out = True
    job.temp_path = os.path.join(job.job_dir, "render.part.mp4")
    open(job.temp_path, "wb").write(b"x")
    src = tmp_path / "a.mp4"
    src.write_bytes(b"src")
    job.leased_paths = integ.lease_paths([str(src)])

    J.fail_job_setup(job, "materialize exploded")
    assert job.status == "error"
    assert job.error and "materialize" in job.error
    assert integ.lease_count(str(src)) == 0
    # Not left as running
    assert J.get_job(job.id).status == "error"


def test_start_export_materialize_failure_terminalizes(tmp_path, monkeypatch):
    """Failure at materialize must not leave status=running."""
    from app.config import get_settings
    get_settings.cache_clear()

    # Minimal asset
    assets = Path(get_settings().work_dir) / "assets"
    assets.mkdir(parents=True, exist_ok=True)
    h = "c" * 32
    asset = assets / f"{h}.mp4"
    asset.write_bytes(b"\x00" * 64)

    def boom(*_a, **_k):
        raise OSError("disk full during materialize")

    monkeypatch.setattr(ex, "materialize_assets", boom)
    monkeypatch.setattr(ex, "ffmpeg_available", lambda: True)

    spec = ex.ExportSpec(
        width=640, height=360, durationSec=1.0,
        clips=[{
            "id": "c1", "trackId": "v1", "kind": "video", "assetId": h,
            "startSec": 0, "inPointSec": 0, "outPointSec": 1, "speed": 1,
        }],
        tracks=[{"id": "v1", "muted": False}],
    )
    started = ex.start_export(spec)
    job = J.JOBS[started["jobId"]]
    deadline = time.time() + 3
    while job.status == "setup" and time.time() < deadline:
        time.sleep(0.01)
    assert job.status == "error"
    assert "materialize" in (job.error or "").lower()

    # No job stuck in running
    running = [j for j in J.JOBS.values() if j.status == "running"]
    assert running == []
    # Any leftover setup jobs must be error
    for j in J.JOBS.values():
        assert j.status in ("error", "cancelled", "done", "setup")
        if j.kind == "export" and j.status == "setup":
            pytest.fail("ghost setup job left after materialize failure")


def test_start_export_http_validation_failure_releases_setup_reservation(tmp_path, monkeypatch):
    """An HTTP 4xx after create_job must not leave setup/quota state active."""
    monkeypatch.setattr(ex, "ffmpeg_available", lambda: True)
    before = set(J.JOBS)
    source = tmp_path / "source.mp4"
    source.write_bytes(b"video")
    spec = ex.ExportSpec(
        width=640,
        height=360,
        durationSec=60.0,
        videoBitrateKbps=8000,
        outputDir="relative-path-is-invalid",
        clips=[{
            "id": "c1",
            "trackId": "v1",
            "kind": "video",
            "assetId": "source",
            "sourcePath": str(source),
            "startSec": 0,
            "inPointSec": 0,
            "outPointSec": 60,
            "speed": 1,
        }],
        tracks=[],
    )

    with pytest.raises(Exception) as ei:
        ex.start_export(spec)

    assert getattr(ei.value, "status_code", None) == 400
    created = [job for jid, job in J.JOBS.items() if jid not in before]
    assert len(created) == 1
    assert created[0].status == "error"
    assert created[0].est_bytes > 0  # retained for diagnostics, no longer active


def test_build_command_failure_terminalizes(tmp_path, monkeypatch):
    from app.config import get_settings
    get_settings.cache_clear()
    assets = Path(get_settings().work_dir) / "assets"
    assets.mkdir(parents=True, exist_ok=True)
    h = "d" * 32
    (assets / f"{h}.mp4").write_bytes(b"\x00" * 32)

    monkeypatch.setattr(ex, "ffmpeg_available", lambda: True)
    monkeypatch.setattr(
        ex, "build_command",
        lambda *a, **k: (_ for _ in ()).throw(RuntimeError("bad filtergraph")),
    )

    spec = ex.ExportSpec(
        width=640, height=360, durationSec=1.0,
        clips=[{
            "id": "c1", "trackId": "v1", "kind": "video", "assetId": h,
            "startSec": 0, "inPointSec": 0, "outPointSec": 1, "speed": 1,
        }],
    )
    started = ex.start_export(spec)
    job = J.JOBS[started["jobId"]]
    deadline = time.time() + 3
    while job.status == "setup" and time.time() < deadline:
        time.sleep(0.01)
    assert job.status == "error"
    assert "filter" in (job.error or "").lower()
    for j in list(J.JOBS.values()):
        if j.kind == "export":
            assert j.status == "error"


def test_export_returns_job_before_copy_and_cancel_stops_setup(tmp_path, monkeypatch):
    from app.config import get_settings
    get_settings.cache_clear()
    assets = Path(get_settings().work_dir) / "assets"
    assets.mkdir(parents=True, exist_ok=True)
    h = "e" * 32
    (assets / f"{h}.mp4").write_bytes(b"source")
    entered = threading.Event()

    def slow_materialize(*_args, cancel_check=None, **_kwargs):
        entered.set()
        deadline = time.time() + 3
        while time.time() < deadline and not (cancel_check and cancel_check()):
            time.sleep(0.01)
        raise integ.MaterializeCancelled("cancelled")

    monkeypatch.setattr(ex, "materialize_assets", slow_materialize)
    monkeypatch.setattr(ex, "ffmpeg_available", lambda: True)
    spec = ex.ExportSpec(
        width=640, height=360, durationSec=10,
        clips=[{
            "id": "c1", "trackId": "v1", "kind": "video", "assetId": h,
            "startSec": 0, "inPointSec": 0, "outPointSec": 10, "speed": 1,
        }],
    )

    started = ex.start_export(spec)
    assert started["jobId"]
    assert entered.wait(timeout=1), "copy should run in the background"
    assert J.cancel_job(started["jobId"]) is True
    job = J.JOBS[started["jobId"]]
    deadline = time.time() + 3
    while job.status == "setup" and time.time() < deadline:
        time.sleep(0.01)
    assert job.status == "cancelled"


def test_cancel_before_worker_cleans_reservation(tmp_path, monkeypatch):
    from app.config import get_settings
    get_settings.cache_clear()
    job = J.create_job(2.0, out_path="", status="setup")
    job.job_dir = str(tmp_path / "exports" / job.id)
    os.makedirs(job.job_dir, exist_ok=True)
    out = tmp_path / "user" / "clip.mp4"
    out.parent.mkdir(parents=True)
    out.write_bytes(b"")
    job.out_path = str(out)
    job.reserved_out = True
    temp = Path(job.job_dir) / "render.part.mp4"
    job.temp_path = str(temp)
    temp.write_bytes(b"partial")
    assert J.cancel_job(job.id) is True
    assert job.status == "cancelled"
    assert not out.exists()
    assert not temp.exists()
    # second cancel is false (already terminal)
    assert J.cancel_job(job.id) is False


def test_init_and_sweep_setup_to_error_cleans_reservation(tmp_path, monkeypatch):
    """#12: kill mid-setup left status=setup + zero-byte reservation forever."""
    from app.config import get_settings

    monkeypatch.setenv("XINCHAO_WORK_DIR", str(tmp_path / "work"))
    get_settings.cache_clear()
    J.JOBS.clear()
    out = tmp_path / "user" / "reserved.mp4"
    out.parent.mkdir(parents=True)
    out.write_bytes(b"")  # O_EXCL placeholder
    job_dir = Path(get_settings().work_dir) / "exports" / "setupdead"
    job_dir.mkdir(parents=True)
    part = job_dir / "render.part.mp4"
    part.write_bytes(b"partial")

    # Persist a setup row without an in-memory process (simulates pre-restart).
    J.persist_job(
        id="setupdead",
        kind="export",
        status="setup",
        pct=0.0,
        error=None,
        duration=5.0,
        out_path=str(out),
        keep_dir=str(out.parent),
    )
    # Also a running row so both branches are covered.
    run_out = tmp_path / "user" / "running.mp4"
    run_out.write_bytes(b"")
    J.persist_job(
        id="rundeads",
        kind="export",
        status="running",
        pct=12.0,
        error=None,
        duration=5.0,
        out_path=str(run_out),
        keep_dir=str(run_out.parent),
    )

    J.JOBS.clear()
    J.init_and_sweep()

    rows = {r["id"]: r for r in J.load_rows(("export", "proxy", "separate"))}
    assert rows["setupdead"]["status"] == "error"
    assert "restarted" in (rows["setupdead"]["error"] or "").lower()
    assert rows["rundeads"]["status"] == "error"
    assert "restarted" in (rows["rundeads"]["error"] or "").lower()

    assert not out.exists(), "setup reservation must be reclaimed"
    assert not run_out.exists(), "running reservation must be reclaimed"
    assert not job_dir.exists(), "job scratch dir under work_dir/exports/<id> removed"

    get_settings.cache_clear()
    J.JOBS.clear()


def test_restart_preserves_output_published_before_terminal_status_save(tmp_path, monkeypatch):
    """Crash after os.replace but before job.save(done) must not delete an hour render."""
    from app.config import get_settings

    monkeypatch.setenv("XINCHAO_WORK_DIR", str(tmp_path / "work"))
    get_settings.cache_clear()
    J.JOBS.clear()
    job_dir = Path(get_settings().work_dir) / "exports" / "publishdead"
    inputs = job_dir / "inputs"
    inputs.mkdir(parents=True)
    (inputs / "snapshot.mp4").write_bytes(b"large source snapshot")
    temp = job_dir / "render.part.mp4"  # persisted path; os.replace removed it
    final = tmp_path / "user" / "finished.mp4"
    final.parent.mkdir(parents=True)
    final.write_bytes(b"complete rendered video")
    cleanup_path = tmp_path / "user" / ".hybrid-video.uploading"
    cleanup_path.write_bytes(b"browser video-only input")
    extra = json.dumps({
        "job_dir": str(job_dir),
        "temp_path": str(temp),
        "reserved_out": True,
        "cleanup_paths": [str(cleanup_path)],
    })
    J.persist_job(
        id="publishdead",
        kind="export",
        status="running",
        pct=99.0,
        error=None,
        duration=3600.0,
        out_path=str(final),
        keep_dir=str(job_dir),
        extra=extra,
    )

    J.init_and_sweep()

    row = next(r for r in J.load_rows(("export",)) if r["id"] == "publishdead")
    assert row["status"] == "done"
    assert row["pct"] == 100
    assert row["error"] is None
    assert final.read_bytes() == b"complete rendered video"
    assert not job_dir.exists(), "external-output scratch must still be reclaimed"
    assert not cleanup_path.exists(), "Hybrid browser input must still be reclaimed"

    get_settings.cache_clear()
    J.JOBS.clear()


def test_restart_recovery_keeps_internal_final_while_dropping_scratch(tmp_path, monkeypatch):
    from app.config import get_settings

    monkeypatch.setenv("XINCHAO_WORK_DIR", str(tmp_path / "work"))
    get_settings.cache_clear()
    J.JOBS.clear()
    job_dir = Path(get_settings().work_dir) / "exports" / "internaldone"
    (job_dir / "inputs").mkdir(parents=True)
    (job_dir / "inputs" / "source.mp4").write_bytes(b"snapshot")
    final = job_dir / "out.mp4"
    final.write_bytes(b"published")
    temp = job_dir / "render.part.mp4"
    J.persist_job(
        id="internaldone",
        kind="export",
        status="running",
        pct=99.0,
        error=None,
        duration=10.0,
        out_path=str(final),
        keep_dir=str(job_dir),
        extra=json.dumps({
            "job_dir": str(job_dir),
            "temp_path": str(temp),
            "reserved_out": True,
        }),
    )

    J.init_and_sweep()

    assert final.read_bytes() == b"published"
    assert not (job_dir / "inputs").exists()
    assert next(r for r in J.load_rows(("export",)) if r["id"] == "internaldone")["status"] == "done"

    get_settings.cache_clear()
    J.JOBS.clear()


def test_server_export_start_request_id_is_idempotent(monkeypatch):
    request_id = "d" * 32
    ex._EXPORT_START_REQUESTS.clear()
    J.JOBS.pop(request_id, None)
    monkeypatch.setattr(ex, "ffmpeg_available", lambda: True)

    class IdleThread:
        def __init__(self, *args, **kwargs):
            pass

        def start(self):
            pass

    monkeypatch.setattr(ex.threading, "Thread", IdleThread)
    spec = ex.ExportSpec(
        width=640,
        height=360,
        durationSec=1,
        clips=[
            {
                "id": "text-1",
                "trackId": "track-1",
                "kind": "text",
                "startSec": 0,
                "inPointSec": 0,
                "outPointSec": 1,
                "speed": 1,
                "textData": {"content": "idempotent"},
            }
        ],
        tracks=[{"id": "track-1", "muted": False}],
        requestId=request_id,
    )

    try:
        first = ex.start_export(spec)
        second = ex.start_export(spec)

        assert first == second
        assert first["jobId"] == request_id
        assert [jid for jid in J.JOBS if jid == request_id] == [request_id]
    finally:
        if request_id in J.JOBS:
            J.fail_job_setup(J.JOBS[request_id], "test cleanup")
            J.JOBS.pop(request_id, None)
        ex._EXPORT_START_REQUESTS.clear()


def test_server_export_thread_start_failure_rolls_back_setup(monkeypatch):
    request_id = "e" * 32
    ex._EXPORT_START_REQUESTS.clear()
    J.JOBS.pop(request_id, None)
    monkeypatch.setattr(ex, "ffmpeg_available", lambda: True)

    class BrokenThread:
        def __init__(self, *args, **kwargs):
            pass

        def start(self):
            raise RuntimeError("cannot start new thread")

    monkeypatch.setattr(ex.threading, "Thread", BrokenThread)
    spec = ex.ExportSpec(
        width=640,
        height=360,
        durationSec=1,
        clips=[
            {
                "id": "text-1",
                "trackId": "track-1",
                "kind": "text",
                "startSec": 0,
                "inPointSec": 0,
                "outPointSec": 1,
                "speed": 1,
                "textData": {"content": "thread failure"},
            }
        ],
        tracks=[{"id": "track-1", "muted": False}],
        requestId=request_id,
    )

    with pytest.raises(ex.HTTPException) as exc:
        ex.start_export(spec)

    assert exc.value.status_code == 503
    job = J.JOBS[request_id]
    assert job.status == "error"
    assert "cannot start export worker" in (job.error or "").lower()
    assert not job.reserved_out
    assert not job.temp_path
    assert not Path(job.job_dir).exists() if job.job_dir else True
    J.JOBS.pop(request_id, None)
    ex._EXPORT_START_REQUESTS.clear()


def test_cancel_tombstone_prevents_racing_server_export_start(monkeypatch):
    request_id = "f" * 32
    ex._EXPORT_START_REQUESTS.clear()
    ex._EXPORT_START_CANCELLED.clear()
    J.JOBS.pop(request_id, None)
    monkeypatch.setattr(ex, "ffmpeg_available", lambda: True)
    spec = ex.ExportSpec(
        width=640,
        height=360,
        durationSec=1,
        clips=[
            {
                "id": "text-1",
                "trackId": "track-1",
                "kind": "text",
                "startSec": 0,
                "inPointSec": 0,
                "outPointSec": 1,
                "speed": 1,
                "textData": {"content": "cancelled start"},
            }
        ],
        tracks=[{"id": "track-1", "muted": False}],
        requestId=request_id,
    )

    assert ex.export_cancel(request_id) == {"ok": True}
    with pytest.raises(ex.HTTPException) as exc:
        ex.start_export(spec)

    assert exc.value.status_code == 409
    assert request_id not in J.JOBS
    ex._EXPORT_START_CANCELLED.clear()


def test_cancel_race_after_spawn_tree_kills(monkeypatch, tmp_path):
    """#13: cancel after Popen but before worker re-check must tree-kill + wait + clear."""
    from app.config import get_settings
    from contextlib import contextmanager

    monkeypatch.setenv("XINCHAO_WORK_DIR", str(tmp_path / "work"))
    get_settings.cache_clear()
    J.JOBS.clear()

    killed: list[int] = []
    waited: list[int] = []

    class FakeProc:
        def __init__(self):
            self.pid = 424242
            self.stdout = iter([])  # empty progress pipe
            self.stderr = iter([])
            self._alive = True

        def poll(self):
            return None if self._alive else 0

        def wait(self, timeout=None):
            waited.append(self.pid)
            self._alive = False
            return -9

        def terminate(self):
            raise AssertionError("bare terminate() must not be used on cancel-race path")

        def kill(self):
            self._alive = False

    out = tmp_path / "out" / "x.mp4"
    out.parent.mkdir(parents=True)
    out.write_bytes(b"")
    job = J.create_job(1.0, out_path=str(out), status="setup")
    job.reserved_out = True

    def race_popen(*_a, **_k):
        # cancel_job ran while _proc was still None — only flipped status.
        job.status = "cancelled"
        return FakeProc()

    def fake_kill(proc):
        killed.append(proc.pid)
        proc._alive = False
        try:
            proc.wait(timeout=1)
        except Exception:
            pass

    monkeypatch.setattr(J.subprocess, "Popen", race_popen)
    monkeypatch.setattr(J, "_kill_proc_tree", fake_kill)

    def immediate_thread(target=None, daemon=None, **_k):
        class T:
            def start(self_inner):
                target()

        return T()

    monkeypatch.setattr(J.threading, "Thread", immediate_thread)

    @contextmanager
    def immediate_guard(*_a, **_k):
        yield

    monkeypatch.setattr(J, "resource_guard", immediate_guard)

    J.run_job(job, ["ffmpeg", "-i", "in", "out"], cwd=str(tmp_path))

    assert killed == [424242], "cancel-race must call tree-kill helper"
    assert waited, "tree-kill / wait must reap the process"
    assert job._proc is None
    assert job.status == "cancelled"
    assert not out.exists()

    get_settings.cache_clear()
    J.JOBS.clear()
