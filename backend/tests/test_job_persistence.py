"""Tests for persistent job state across backend restarts (TASK-26)."""
from __future__ import annotations

import json
import os

import pytest


@pytest.fixture()
def store(monkeypatch, tmp_path):
    """Fresh work dir + empty in-memory registries, restored after the test."""
    monkeypatch.setenv("XINCHAO_WORK_DIR", str(tmp_path))
    from app.config import get_settings
    get_settings.cache_clear()
    from app.export import job as J
    from app.routers import separate as S
    J.JOBS.clear()
    S.JOBS.clear()
    yield J, S, tmp_path
    J.JOBS.clear()
    S.JOBS.clear()
    get_settings.cache_clear()


def _row(J, jid):
    rows = [r for r in J.load_rows(("export", "proxy", "separate")) if r["id"] == jid]
    return rows[0] if rows else None


def test_create_job_persists_running_row(store):
    J, _S, tmp = store
    job = J.create_job(10.0, out_path=str(tmp / "exports" / "x" / "out.mp4"))
    row = _row(J, job.id)
    assert row is not None
    assert row["status"] == "running"
    assert row["kind"] == "export"


def test_save_roundtrips_status_and_pct(store):
    J, _S, tmp = store
    job = J.create_job(10.0, out_path=str(tmp / "proxies" / "p1" / "out.mp4"), kind="proxy")
    job.pct = 42.0
    job.status = "done"
    job.save()
    row = _row(J, job.id)
    assert row["status"] == "done"
    assert row["pct"] == 42.0
    assert row["kind"] == "proxy"


def test_restart_marks_running_as_error_and_keeps_done(store):
    J, _S, tmp = store
    out_dir = tmp / "exports" / "keepme"
    out_dir.mkdir(parents=True)
    done = J.create_job(5.0, out_path=str(out_dir / "out.mp4"))
    done.status = "done"
    done.pct = 100.0
    done.save()
    running = J.create_job(5.0, out_path=str(tmp / "exports" / "dead" / "out.mp4"))
    assert running.status == "running"

    # ── simulate process death + restart ──
    J.JOBS.clear()
    J.init_and_sweep()
    keep = J.restore_into_memory()

    assert set(J.JOBS) == {done.id, running.id}
    restored_done = J.JOBS[done.id]
    assert restored_done.status == "done"
    assert restored_done.pct == 100.0
    assert restored_done.out_path == str(out_dir / "out.mp4")
    restored_running = J.JOBS[running.id]
    assert restored_running.status == "error"
    assert "restarted" in (restored_running.error or "")
    # Only the DONE job's dir is protected from the startup cleanup.
    assert os.path.abspath(str(out_dir)) in keep
    assert len(keep) == 1


def test_separate_jobs_restore_with_stems(store):
    J, S, tmp = store
    work = tmp / "separate" / "abc"
    work.mkdir(parents=True)
    job = S.SepJob(id="sep1", out_dir=str(work))
    S.JOBS[job.id] = job
    job.vocals = str(work / "vocals.wav")
    job.music = str(work / "no_vocals.wav")
    job.pct = 100.0
    job.status = "done"
    job.save()

    S.JOBS.clear()
    keep = S.restore_sep_jobs()

    r = S.JOBS["sep1"]
    assert r.status == "done"
    assert r.vocals == str(work / "vocals.wav")
    assert r.music == str(work / "no_vocals.wav")
    assert os.path.abspath(str(work)) in keep
    # extra column actually carries the stems as JSON
    row = _row(J, "sep1")
    assert json.loads(row["extra"])["vocals"] == str(work / "vocals.wav")


def test_sweep_prunes_rows_past_max(store):
    J, _S, tmp = store
    # Realistic per-job output dirs (work_dir/exports/<id>/out.mp4), so pruning
    # a job rmtree's only its own dir — never the work dir that holds jobs.db.
    for i in range(J.MAX_JOBS + 5):
        j = J.create_job(1.0, out_path=str(tmp / "exports" / f"o{i}" / "out.mp4"))
        j.status = "done"
        j.save()
    J.init_and_sweep()
    rows = J.load_rows(("export", "proxy", "separate"))
    assert len(rows) == J.MAX_JOBS


def test_safe_rmtree_never_deletes_work_dir(store, tmp_path):
    J, _S, tmp = store
    # A shallow out_path whose dir IS the work dir must not wipe it (guards the
    # persistent assets/ models/ jobs.db). The job dir cleanup is a no-op here.
    (tmp / "assets").mkdir()
    (tmp / "assets" / "keep.bin").write_bytes(b"x")
    J.safe_rmtree_jobdir(str(tmp))            # == work dir → refused
    J.safe_rmtree_jobdir(str(tmp.parent))     # above work dir → refused
    assert (tmp / "assets" / "keep.bin").exists()
    # A real job subdir IS removed.
    jobdir = tmp / "exports" / "j1"
    jobdir.mkdir(parents=True)
    (jobdir / "out.mp4").write_bytes(b"y")
    J.safe_rmtree_jobdir(str(jobdir))
    assert not jobdir.exists()


def test_prune_deletes_row_with_evicted_job(store):
    J, _S, tmp = store
    jobs = []
    for i in range(J.MAX_JOBS + 3):
        j = J.create_job(1.0, out_path=str(tmp / f"d{i}" / "out.mp4"))
        j.status = "done"
        j.save()
        jobs.append(j)
    J._prune()
    assert len(J.JOBS) <= J.MAX_JOBS
    evicted = [j.id for j in jobs if j.id not in J.JOBS]
    assert evicted
    for jid in evicted:
        assert _row(J, jid) is None


def test_export_preempts_running_proxies(store):
    J, _S, tmp = store
    proxy = J.create_job(10.0, out_path=str(tmp / "proxies" / "p" / "proxy.mp4"), kind="proxy")
    queued = J.create_job(10.0, out_path=str(tmp / "proxies" / "q" / "proxy.mp4"), kind="proxy")
    export = J.create_job(10.0, out_path=str(tmp / "exports" / "e" / "out.mp4"))
    done_proxy = J.create_job(1.0, out_path=str(tmp / "proxies" / "d" / "proxy.mp4"), kind="proxy")
    done_proxy.status = "done"

    n = J.preempt_proxies()

    assert n == 2
    assert proxy.status == "cancelled"
    assert queued.status == "cancelled"
    assert export.status == "running"      # exports are never preempted
    assert done_proxy.status == "done"     # finished proxies untouched


def test_clean_work_keeps_done_dirs_and_removes_orphans(store):
    J, _S, tmp = store
    # A completed export whose dir must survive...
    keep_dir = tmp / "exports" / "donejob"
    keep_dir.mkdir(parents=True)
    (keep_dir / "out.mp4").write_bytes(b"x")
    job = J.create_job(5.0, out_path=str(keep_dir / "out.mp4"))
    job.status = "done"
    job.save()
    # ...and an orphaned dir nothing references.
    orphan = tmp / "exports" / "orphan"
    orphan.mkdir(parents=True)
    (orphan / "junk.mp4").write_bytes(b"y")

    J.JOBS.clear()  # simulate restart
    from app.main import _clean_work
    _clean_work()

    assert keep_dir.exists(), "completed job output must survive startup cleanup"
    assert not orphan.exists(), "orphaned job dir must be removed"
    assert J.JOBS[job.id].status == "done"  # restored and pollable


def test_clean_work_restore_failure_never_deletes_unknown_outputs(store, monkeypatch):
    J, _S, tmp = store
    output = tmp / "exports" / "must-survive" / "out.mp4"
    output.parent.mkdir(parents=True)
    output.write_bytes(b"completed-video")
    separated = tmp / "separate" / "must-survive" / "vocals.wav"
    separated.parent.mkdir(parents=True)
    separated.write_bytes(b"audio")
    def fail_restore():
        raise RuntimeError("database temporarily locked")

    monkeypatch.setattr(J, "restore_into_memory", fail_restore)

    from app.main import _clean_work
    _clean_work()

    assert output.read_bytes() == b"completed-video"
    assert separated.read_bytes() == b"audio"
