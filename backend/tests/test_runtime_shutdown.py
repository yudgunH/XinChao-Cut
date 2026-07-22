from __future__ import annotations

from types import SimpleNamespace


def test_export_cancel_active_jobs_uses_snapshot(monkeypatch):
    from app.export import job as jobs

    original = dict(jobs.JOBS)
    jobs.JOBS.clear()
    jobs.JOBS.update({
        "setup": SimpleNamespace(status="setup"),
        "running": SimpleNamespace(status="running"),
        "done": SimpleNamespace(status="done"),
    })
    cancelled: list[str] = []
    monkeypatch.setattr(
        jobs, "cancel_job", lambda job_id: cancelled.append(job_id) or True
    )
    try:
        assert jobs.cancel_active_jobs() == 2
        assert cancelled == ["setup", "running"]
    finally:
        jobs.JOBS.clear()
        jobs.JOBS.update(original)


def test_scene_shutdown_tree_kills_live_process(monkeypatch):
    from app.routers import media

    proc = object()
    live = media._SceneJob("live", 5.0, _proc=proc)
    done = media._SceneJob("done", 5.0, status="done", _proc=object())
    killed: list[object] = []
    monkeypatch.setattr(media, "kill_process_tree", killed.append)
    with media._SCENE_JOBS_LOCK:
        original = dict(media._SCENE_JOBS)
        media._SCENE_JOBS.clear()
        media._SCENE_JOBS.update({"live": live, "done": done})
    try:
        assert media.shutdown_active_scene_jobs() == 1
        assert live.status == "cancelled"
        assert live._proc is None
        assert killed == [proc]
    finally:
        with media._SCENE_JOBS_LOCK:
            media._SCENE_JOBS.clear()
            media._SCENE_JOBS.update(original)


def test_separation_shutdown_only_cancels_running(monkeypatch):
    from app.routers import separate

    original = dict(separate.JOBS)
    separate.JOBS.clear()
    separate.JOBS.update({
        "live": SimpleNamespace(status="running"),
        "done": SimpleNamespace(status="done"),
    })
    cancelled: list[str] = []
    monkeypatch.setattr(
        separate, "separation_cancel", lambda job_id: cancelled.append(job_id) or {"ok": True}
    )
    try:
        assert separate.shutdown_active_jobs() == 1
        assert cancelled == ["live"]
    finally:
        separate.JOBS.clear()
        separate.JOBS.update(original)


def test_tts_shutdown_cancels_jobs_and_reaps_worker(tmp_path, monkeypatch):
    from app.routers import tts

    active_dir = tmp_path / "active"
    done_dir = tmp_path / "done"
    active_dir.mkdir()
    done_dir.mkdir()
    active = SimpleNamespace(
        cancelled=False,
        out_dir=str(active_dir),
        read_progress=lambda: {"status": "running"},
    )
    done = SimpleNamespace(
        cancelled=False,
        out_dir=str(done_dir),
        read_progress=lambda: {"status": "done"},
    )
    original = dict(tts.JOBS)
    tts.JOBS.clear()
    tts.JOBS.update({"active": active, "done": done})
    stopped: list[bool] = []
    monkeypatch.setattr(tts._WORKER_MGR, "shutdown", lambda: stopped.append(True))
    try:
        assert tts.shutdown_active_jobs() == 1
        assert active.cancelled is True
        assert done.cancelled is False
        assert (active_dir / "cancel").exists()
        assert stopped == [True]
    finally:
        tts.JOBS.clear()
        tts.JOBS.update(original)


def test_transcription_shutdown_signal_is_idempotent():
    from app.routers import transcribe

    transcribe.resume_runtime()
    check = transcribe._shutdown_aware_cancel(lambda: False)
    assert check() is False
    assert transcribe.shutdown_runtime() == 1
    assert transcribe.shutdown_runtime() == 0
    assert check() is True
    transcribe.resume_runtime()
    assert check() is False
