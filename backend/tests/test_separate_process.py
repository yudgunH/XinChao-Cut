"""Demucs separate: process_runner cancel + GPU permit only around demucs."""
from __future__ import annotations

import io
import sys
import threading
import time
from pathlib import Path
from unittest.mock import MagicMock

import pytest
from fastapi import UploadFile

from app.resource_coordinator import (
    ResourceCoordinator,
    get_coordinator,
    set_coordinator,
)
from app.routers import separate as S
from app import process_runner as pr


@pytest.fixture(autouse=True)
def _fresh(tmp_path, monkeypatch):
    set_coordinator(ResourceCoordinator())
    monkeypatch.setenv("XINCHAO_WORK_DIR", str(tmp_path / "work"))
    from app.config import get_settings
    get_settings.cache_clear()
    S.JOBS.clear()
    S._CANCELLED_STARTS.clear()
    S._PENDING_RELEASES.clear()
    yield
    S.JOBS.clear()
    S._CANCELLED_STARTS.clear()
    S._PENDING_RELEASES.clear()
    set_coordinator(None)
    get_settings.cache_clear()


def _py_sleep(seconds: float = 999) -> list[str]:
    return [sys.executable, "-c", f"import time; time.sleep({seconds})"]


def test_cancel_during_demucs_kills_process_and_finishes(monkeypatch, tmp_path):
    """Cancel while demucs-like child is running → cancelled, no hang, tree reaped."""
    work = tmp_path / "sep" / "j1"
    work.mkdir(parents=True)
    in_path = work / "in.wav"
    in_path.write_bytes(b"RIFF")

    job = S.SepJob(id="j1", out_dir=str(work), status="running")
    S.JOBS[job.id] = job

    entered = threading.Event()
    child_pid: list[int] = []

    def fake_run_process(cmd, **kwargs):
        if cmd and "ffmpeg" in str(cmd[0]):
            wav = Path(cmd[-1])
            wav.parent.mkdir(parents=True, exist_ok=True)
            wav.write_bytes(b"wav")
            return pr.ProcessResult(
                returncode=0, stdout="", stderr="", outcome=pr.ProcessOutcome.OK,
                duration_sec=0.01, pid=1,
            )
        # demucs stand-in: real long process via process_runner cancel path
        entered.set()
        try:
            return pr.run_process(
                _py_sleep(999),
                timeout=kwargs.get("timeout", 30),
                cancel_check=kwargs.get("cancel_check"),
                on_spawn=kwargs.get("on_spawn"),
                poll_interval=0.05,
                raise_on_error=True,
            )
        except pr.ProcessCancelled as e:
            # Record that tree kill path ran (no active roots after).
            child_pid.append(-1)
            raise e

    monkeypatch.setattr(S, "run_process", fake_run_process)
    monkeypatch.setattr(S, "_device", lambda: "cpu")

    S._run(job, str(in_path), str(work))
    assert entered.wait(timeout=5)

    # Same as cancel endpoint: status first (cancel_check), then optional tree kill.
    S.separation_cancel("j1")

    deadline = time.monotonic() + 10
    while time.monotonic() < deadline and job.status == "running":
        time.sleep(0.05)

    assert job.status == "cancelled"
    time.sleep(0.4)
    for pid in list(pr.active_root_pids()):
        assert not pr.pid_alive(pid), f"orphan pid still alive: {pid}"


def test_gpu_permit_not_held_during_ffmpeg_normalize(monkeypatch, tmp_path):
    """GPU_MODEL free while normalization runs; held only during demucs."""
    work = tmp_path / "sep" / "j2"
    work.mkdir(parents=True)
    in_path = work / "in.wav"
    in_path.write_bytes(b"x")

    job = S.SepJob(id="j2", out_dir=str(work), status="running")
    S.JOBS[job.id] = job

    phases: list[str] = []
    free_during_ffmpeg: list[int] = []
    free_during_demucs: list[int] = []
    coord = get_coordinator()

    def fake_run_process(cmd, **kwargs):
        if cmd and "ffmpeg" in str(cmd[0]):
            free_during_ffmpeg.append(coord.pool_free())
            phases.append("ffmpeg")
            wav = Path(cmd[-1])
            wav.write_bytes(b"wav")
            return pr.ProcessResult(
                returncode=0, stdout="", stderr="", outcome=pr.ProcessOutcome.OK,
                duration_sec=0.01, pid=1,
            )
        free_during_demucs.append(coord.pool_free())
        phases.append("demucs")
        out = None
        for i, a in enumerate(cmd):
            if a == "-o" and i + 1 < len(cmd):
                out = Path(cmd[i + 1])
        if out:
            stem_dir = out / S._MODEL / "audio"
            stem_dir.mkdir(parents=True, exist_ok=True)
            (stem_dir / "vocals.wav").write_bytes(b"v")
            (stem_dir / "no_vocals.wav").write_bytes(b"m")
        return pr.ProcessResult(
            returncode=0, stdout="", stderr="", outcome=pr.ProcessOutcome.OK,
            duration_sec=0.01, pid=2,
        )

    monkeypatch.setattr(S, "run_process", fake_run_process)
    monkeypatch.setattr(S, "_device", lambda: "cpu")

    S._run(job, str(in_path), str(work))
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline and job.status == "running":
        time.sleep(0.05)

    assert phases == ["ffmpeg", "demucs"]
    assert free_during_ffmpeg and free_during_ffmpeg[0] >= 1
    assert free_during_demucs and free_during_demucs[0] == 0
    assert job.status == "done"
    # status is persisted inside the resource_guard; allow the worker to exit
    # the with-block and return the permit before asserting (avoid CI race).
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline and coord.pool_free() != 1:
        time.sleep(0.01)
    assert coord.pool_free() == 1


def test_separation_cancel_sets_status_and_tree_kills(monkeypatch, tmp_path):
    """Cancel endpoint marks cancelled and tree-kills job._proc if set."""
    job = S.SepJob(id="j3", out_dir=str(tmp_path), status="running")
    S.JOBS["j3"] = job

    proc = MagicMock()
    proc.poll.return_value = None
    proc.pid = 424242
    job._proc = proc

    killed: list = []
    monkeypatch.setattr(S, "kill_process_tree", lambda p: killed.append(p))

    S.separation_cancel("j3")

    assert job.status == "cancelled"
    assert killed == [proc]
    assert job._proc is None


def test_separation_reserves_upload_and_three_pcm_surfaces(monkeypatch):
    captured: list[tuple[int, bool, str]] = []
    monkeypatch.setattr(S, "ffmpeg_available", lambda: True)
    monkeypatch.setattr(S, "demucs_available", lambda: True)
    monkeypatch.setattr(S, "cleanup_job_dirs", lambda: 0)
    monkeypatch.setattr(S, "probe_duration", lambda _path: 10.0)
    monkeypatch.setattr(S, "_run", lambda *_args: None)
    monkeypatch.setattr(
        S,
        "reserve_external_output",
        lambda _id, estimated, _free, _volume, **kwargs: captured.append(
            (estimated, kwargs["counts_toward_jobs_quota"], kwargs["store_path"])
        ),
    )
    monkeypatch.setattr(S, "update_external_output_written", lambda *_args: None)
    upload = UploadFile(file=io.BytesIO(b"1234"), size=4, filename="input.wav")

    result = S.start_separation(file=upload, sourcePath="")

    pcm = int(10 * 44_100 * 2 * 2)
    assert len(captured) == 2
    assert captured[0][0] == 4 + 512 * 1024 * 1024
    assert captured[1][0] == 4 + pcm * 3 + 512 * 1024 * 1024
    assert all(counts for _size, counts, _path in captured)
    job = S.JOBS[result["jobId"]]
    S.release_external_output(job._reservation_id)
    S.safe_rmtree_jobdir(job.out_dir)


def test_separation_stable_request_id_is_idempotent(monkeypatch):
    request_id = "a" * 32
    reserve_calls: list[str] = []
    monkeypatch.setattr(S, "ffmpeg_available", lambda: True)
    monkeypatch.setattr(S, "demucs_available", lambda: True)
    monkeypatch.setattr(S, "cleanup_job_dirs", lambda: 0)
    monkeypatch.setattr(S, "probe_duration", lambda _path: 1.0)
    monkeypatch.setattr(S, "_run", lambda *_args: None)
    monkeypatch.setattr(
        S,
        "reserve_external_output",
        lambda reservation_id, *_args, **_kwargs: reserve_calls.append(reservation_id),
    )
    monkeypatch.setattr(S, "update_external_output_written", lambda *_args: None)

    first = S.start_separation(
        file=UploadFile(file=io.BytesIO(b"1234"), size=4, filename="input.wav"),
        sourcePath="",
        requestId=request_id,
    )
    second = S.start_separation(
        file=UploadFile(file=io.BytesIO(b"different"), size=9, filename="other.wav"),
        sourcePath="",
        requestId=request_id,
    )

    assert first == second == {"jobId": request_id}
    assert len(reserve_calls) == 2, "retry must not perform a second admission/copy"


def test_cancel_tombstone_prevents_racing_separation_start(monkeypatch):
    request_id = "b" * 32
    launched: list[str] = []
    monkeypatch.setattr(S, "ffmpeg_available", lambda: True)
    monkeypatch.setattr(S, "demucs_available", lambda: True)
    monkeypatch.setattr(S, "cleanup_job_dirs", lambda: 0)
    monkeypatch.setattr(S, "_run", lambda job, *_args: launched.append(job.id))

    assert S.separation_cancel(request_id) == {"ok": True}
    with pytest.raises(S.HTTPException) as exc:
        S.start_separation(
            file=UploadFile(file=io.BytesIO(b"1234"), size=4, filename="input.wav"),
            sourcePath="",
            requestId=request_id,
        )

    assert exc.value.status_code == 409
    assert request_id not in S.JOBS
    assert launched == []


def test_separation_thread_start_failure_removes_job_and_reservation(monkeypatch):
    request_id = "c" * 32
    released: list[str] = []
    monkeypatch.setattr(S, "ffmpeg_available", lambda: True)
    monkeypatch.setattr(S, "demucs_available", lambda: True)
    monkeypatch.setattr(S, "cleanup_job_dirs", lambda: 0)
    monkeypatch.setattr(S, "probe_duration", lambda _path: 1.0)
    monkeypatch.setattr(S, "reserve_external_output", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(S, "update_external_output_written", lambda *_args: None)
    monkeypatch.setattr(S, "release_external_output", lambda rid: released.append(rid))
    monkeypatch.setattr(S, "_run", lambda *_args: (_ for _ in ()).throw(RuntimeError("no thread")))

    with pytest.raises(RuntimeError, match="no thread"):
        S.start_separation(
            file=UploadFile(file=io.BytesIO(b"1234"), size=4, filename="input.wav"),
            sourcePath="",
            requestId=request_id,
        )

    assert request_id not in S.JOBS
    assert released == [f"separate-{request_id}"]


def test_cancelled_job_cannot_be_resurrected_by_late_stem_publish(monkeypatch, tmp_path):
    job = S.SepJob(id="late", out_dir=str(tmp_path), status="running")
    monkeypatch.setattr(S.SepJob, "save", lambda _self: None)
    S.JOBS[job.id] = job

    S.release_separation_job(job.id)
    assert job.status == "cancelled"
    assert S._publish_completed_stems(job, "/late/vocals.wav", "/late/music.wav") is False
    assert job.status == "cancelled"
    assert job.vocals is None and job.music is None


def test_terminal_release_waits_for_active_export_lease(monkeypatch, tmp_path):
    from app.export import integrity
    from app.config import get_settings

    work = Path(get_settings().work_dir) / "separate" / "leased"
    work.mkdir(parents=True)
    vocals = work / "vocals.wav"
    music = work / "music.wav"
    vocals.write_bytes(b"v")
    music.write_bytes(b"m")
    job = S.SepJob(
        id="leased",
        out_dir=str(work),
        status="done",
        vocals=str(vocals),
        music=str(music),
    )
    monkeypatch.setattr(S.SepJob, "save", lambda _self: None)
    S.JOBS[job.id] = job
    leased = {str(music)}
    monkeypatch.setattr(integrity, "is_path_leased", lambda path: path in leased)
    deferred: list[tuple] = []

    class DeferredThread:
        def __init__(self, *, target, args, daemon):
            assert daemon is True
            deferred.append((target, args))

        def start(self):
            return None

    monkeypatch.setattr(S.threading, "Thread", DeferredThread)
    S.release_separation_job(job.id)

    assert job.status == "cancelled"
    assert job._release_pending is True
    assert job.id in S.JOBS
    assert music.exists(), "leased stem must survive project cleanup"
    assert len(deferred) == 1

    leased.clear()
    target, args = deferred[0]
    target(*args)
    assert job.id not in S.JOBS
    assert not work.exists()
