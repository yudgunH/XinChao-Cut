"""#11 scene-detect streaming/maxScenes + #12 proxy job_dir recovery."""
from __future__ import annotations

import json
import os
from unittest.mock import MagicMock

import pytest
from fastapi import HTTPException


@pytest.fixture()
def work(monkeypatch, tmp_path):
    monkeypatch.setenv("XINCHAO_WORK_DIR", str(tmp_path))
    from app.config import get_settings

    get_settings.cache_clear()
    from app.export import job as J
    from app.routers import media as M

    J.JOBS.clear()
    with M._SCENE_JOBS_LOCK:
        M._SCENE_JOBS.clear()
    yield J, M, tmp_path
    J.JOBS.clear()
    with M._SCENE_JOBS_LOCK:
        M._SCENE_JOBS.clear()
    get_settings.cache_clear()


def test_scene_drain_caps_scenes_and_stderr_tail(work, monkeypatch):
    """Streaming parser keeps ≤ maxScenes cuts and only a short stderr tail."""
    J, M, tmp = work

    # Fake ffmpeg: write many showinfo lines + progress, then hang until killed.
    script = tmp / "fake_ffmpeg.py"
    n_markers = 200
    lines = "\n".join(f"[Parsed_showinfo_0 @ 0x0] n: 0 pts_time:{i * 1.0:.3f}" for i in range(n_markers))
    script.write_text(
        "import sys, time\n"
        f"sys.stderr.write({lines!r} + '\\n')\n"
        "sys.stderr.flush()\n"
        "sys.stdout.write('out_time_us=5000000\\n')\n"
        "sys.stdout.flush()\n"
        "time.sleep(30)\n",
        encoding="utf-8",
    )

    real_popen = __import__("subprocess").Popen

    def fake_popen(cmd, **kwargs):
        # Replace ffmpeg binary with our script
        return real_popen(
            [__import__("sys").executable, str(script)],
            stdout=kwargs.get("stdout"),
            stderr=kwargs.get("stderr"),
            text=kwargs.get("text"),
            bufsize=kwargs.get("bufsize", 1),
        )

    monkeypatch.setattr(M.subprocess, "Popen", fake_popen)
    monkeypatch.setattr(
        M,
        "HEAVY_JOB_SEMAPHORE",
        MagicMock(acquire=lambda **_kwargs: True, release=lambda: None),
    )
    monkeypatch.setattr(M, "detect_video_encoder", lambda _codec="h264": "libx264")
    # No real kill needed beyond terminate
    monkeypatch.setattr(M, "kill_process_tree", lambda p: p.kill())

    job = M._SceneJob(id="sc1", duration=60.0)
    max_scenes = 5
    M._run_scene_detect(job, str(tmp / "in.mp4"), threshold=0.3, min_gap=0.1, max_scenes=max_scenes, cleanup_path=None)

    assert job.status == "done"
    assert len(job.scenes) == max_scenes
    # First accepted scene is pts 1.0 (0.0 skipped as ≤0.05)
    assert job.scenes[0] == pytest.approx(1.0)


def test_scene_cancel_uses_tree_kill(work, monkeypatch):
    J, M, tmp = work
    killed: list = []

    proc = MagicMock()
    monkeypatch.setattr(M, "kill_process_tree", lambda p: killed.append(p))

    job = M._SceneJob(id="sc2", duration=10.0)
    job._proc = proc
    job.status = "running"
    with M._SCENE_JOBS_LOCK:
        M._SCENE_JOBS[job.id] = job

    result = M.media_scenes_cancel(job.id)
    assert result == {"ok": True}
    assert job.status == "cancelled"
    assert killed == [proc]
    assert job._proc is None


def test_scene_rejected_upload_removes_mkstemp_destination(work, monkeypatch):
    """A failed bounded upload must not accumulate empty files in work/scenes."""
    _J, M, tmp = work
    upload = MagicMock()
    upload.filename = "too-large.mp4"

    def reject(_file, _path):
        raise HTTPException(status_code=413, detail="too large")

    monkeypatch.setattr(M, "save_upload_bounded", reject)

    with pytest.raises(HTTPException) as caught:
        M._media_scenes_admitted(
            upload,
            threshold=0.35,
            minGapSec=0.6,
            maxScenes=100,
            hash="",
            sourcePath="",
        )

    assert caught.value.status_code == 413
    scene_dir = tmp / "scenes"
    assert scene_dir.is_dir()
    assert list(scene_dir.iterdir()) == []


def test_proxy_uses_job_id_as_directory_and_persists_job_dir(work):
    J, M, tmp = work
    # Don't run real ffmpeg — only test setup wiring by stubbing run_job + probe
    from unittest.mock import patch

    created: dict = {}

    def capture_run(job, cmd, cwd):
        created["job"] = job
        created["cmd"] = cmd
        created["cwd"] = cwd
        job.status = "running"
        job.save()

    with patch.object(M.ffmpeg_utils, "probe", return_value={"durationSec": 3.0}):
        with patch.object(M, "run_job", side_effect=capture_run):
            with patch.object(M, "detect_video_encoder", return_value="libx264"):
                with patch.object(M, "proxy_quality_args", return_value=["-crf", "26"]):
                    # sourcePath absolute
                    src = tmp / "src.mp4"
                    src.write_bytes(b"fake")
                    with patch.object(M, "resolve_source_path", return_value=str(src)):
                        with patch.object(M, "ffmpeg_available", return_value=True):
                            with patch.object(M, "asset_path", return_value=None):
                                result = M.media_proxy(sourcePath=str(src), height=480)

    job = created["job"]
    assert result["jobId"] == job.id
    assert job.job_dir == os.path.join(str(tmp), "proxies", job.id)
    assert os.path.isdir(job.job_dir)
    assert job.temp_path.endswith("proxy.part.mp4")
    assert job.out_path.endswith("proxy.mp4")
    assert job.reserved_out is True
    assert job.temp_path in " ".join(created["cmd"]) or created["cmd"][-1] == job.temp_path
    assert "-an" not in created["cmd"]
    assert created["cmd"][created["cmd"].index("-c:a") + 1] == "aac"
    assert "0:a:0?" in created["cmd"]

    row = [r for r in J.load_rows(("proxy",)) if r["id"] == job.id][0]
    extra = json.loads(row["extra"])
    assert extra["job_dir"] == job.job_dir
    assert extra["temp_path"] == job.temp_path
    assert extra["reserved_out"] is True
    assert row["keep_dir"] == job.job_dir


def test_proxy_cancel_is_kind_scoped_and_terminalizes_job(work):
    J, M, _tmp = work
    proxy = J.create_job(5.0, out_path="", kind="proxy", status="running")

    assert M.media_proxy_cancel(proxy.id) == {"ok": True}
    assert proxy.status == "cancelled"

    export = J.create_job(5.0, out_path="", kind="export", status="running")
    with pytest.raises(HTTPException) as caught:
        M.media_proxy_cancel(export.id)
    assert caught.value.status_code == 404
    assert export.status == "running"


def test_restart_cleans_orphaned_proxy_dir(work):
    """Kill mid-proxy → init_and_sweep removes work/proxies/<job_id>."""
    J, M, tmp = work
    jid = "proxydead01"
    pdir = tmp / "proxies" / jid
    pdir.mkdir(parents=True)
    part = pdir / "proxy.part.mp4"
    part.write_bytes(b"partial" * 100)
    final = pdir / "proxy.mp4"
    final.write_bytes(b"")  # O_EXCL reservation

    job = J.create_job(5.0, out_path=str(final), kind="proxy", status="running")
    # Force known id by rewriting — create_job assigns random id; use that id's dir
    jid = job.id
    pdir = tmp / "proxies" / jid
    pdir.mkdir(parents=True, exist_ok=True)
    part = pdir / "proxy.part.mp4"
    part.write_bytes(b"partial" * 100)
    final = pdir / "proxy.mp4"
    final.write_bytes(b"")
    job.out_path = str(final)
    job.job_dir = str(pdir)
    job.temp_path = str(part)
    job.reserved_out = True
    job.status = "running"
    job.save()

    assert pdir.is_dir()

    J.JOBS.clear()
    J.init_and_sweep()
    J.restore_into_memory()

    restored = J.JOBS.get(jid)
    assert restored is not None
    assert restored.status == "error"
    assert "restarted" in (restored.error or "")
    assert not pdir.exists(), "orphaned proxy job_dir must be removed on startup"
