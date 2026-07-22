"""Export reservation must reject an output that can't land BEFORE encoding it,
and must aggregate across concurrent exports.

`assert_output_fits_jobs_quota` existed but had no caller: an export larger than
the jobs quota encoded fine, reported done, and was then LRU-deleted — the
download 404s. And two exports that each fit alone could jointly overrun the
quota / free disk because the check was per-output, not aggregate (#4).
"""
from __future__ import annotations

import types

import pytest
from fastapi import HTTPException

from app.export import job as jobmod
from app.export.job import (
    InsufficientSpace,
    Job,
    QuotaExceeded,
    reserve_export_quota,
    reserve_export_scratch,
    reserve_external_output,
    release_external_output,
    update_external_output_written,
)
from app.routers import export as ex

_REAL_JOBS_STORE_SNAPSHOT = jobmod._jobs_store_committed_snapshot


@pytest.fixture(autouse=True)
def _clean_jobs(monkeypatch):
    jobmod.JOBS.clear()
    jobmod._EXTERNAL_OUTPUT_RESERVATIONS.clear()
    monkeypatch.setattr(jobmod, "_jobs_store_committed_snapshot", lambda: (0, {}))
    yield
    jobmod.JOBS.clear()
    jobmod._EXTERNAL_OUTPUT_RESERVATIONS.clear()


def _register(job_id: str, status: str = "setup", est: int = 0) -> None:
    jobmod.JOBS[job_id] = Job(id=job_id, duration=1.0, out_path="", status=status, est_bytes=est)


def _quota(monkeypatch, mb: int) -> None:
    monkeypatch.setattr(jobmod, "jobs_quota_bytes", lambda: mb * 1024 * 1024)


MB = 1024 * 1024


# ── estimate ────────────────────────────────────────────────────────────────

def test_estimate_scales_with_duration_and_bitrate():
    small = ex.estimate_output_bytes(10.0, 8000)
    assert ex.estimate_output_bytes(20.0, 8000) > small
    assert ex.estimate_output_bytes(10.0, 16000) > small
    assert 9 * MB < small < 12 * MB


def test_estimate_is_zero_for_degenerate_inputs():
    assert ex.estimate_output_bytes(0, 8000) == 0
    assert ex.estimate_output_bytes(10, 0) == 0


# ── single-output reservation ─────────────────────────────────────────────────

def test_rejects_output_over_quota(monkeypatch):
    _quota(monkeypatch, 100)
    _register("j1")
    with pytest.raises(QuotaExceeded):
        reserve_export_quota("j1", 200 * MB)
    # Reservation cleared on failure so it doesn't poison later aggregates.
    assert jobmod.JOBS["j1"].est_bytes == 0


def test_allows_output_that_fits(monkeypatch):
    _quota(monkeypatch, 100)
    _register("j1")
    reserve_export_quota("j1", 50 * MB)
    assert jobmod.JOBS["j1"].est_bytes == 50 * MB


def test_rejects_over_free_space_even_under_quota(monkeypatch):
    _quota(monkeypatch, 10_000)
    _register("j1")
    with pytest.raises(InsufficientSpace):
        reserve_export_quota("j1", 500 * MB, free_bytes=100 * MB)


def test_zero_free_space_is_rejected(monkeypatch):
    _quota(monkeypatch, 10_000)
    _register("j1")
    with pytest.raises(InsufficientSpace):
        reserve_export_quota("j1", MB, free_bytes=0, volume="dev:1")


# ── aggregate across concurrent jobs (#4) ─────────────────────────────────────

def test_two_exports_that_fit_alone_but_not_together_are_rejected(monkeypatch):
    _quota(monkeypatch, 8_000)  # 8 GB
    _register("a")
    _register("b")
    # First 6 GB export fits.
    reserve_export_quota("a", 6_000 * MB)
    # Second 6 GB export: 6 + 6 = 12 GB > 8 GB quota → rejected.
    with pytest.raises(QuotaExceeded):
        reserve_export_quota("b", 6_000 * MB)
    assert jobmod.JOBS["b"].est_bytes == 0


def test_finished_job_reservation_drops_out_of_aggregate(monkeypatch):
    _quota(monkeypatch, 8_000)
    _register("a", status="done", est=6_000 * MB)  # already finished
    _register("b")
    # 'a' is done → not counted; 'b' at 6 GB fits under 8 GB.
    reserve_export_quota("b", 6_000 * MB)
    assert jobmod.JOBS["b"].est_bytes == 6_000 * MB


def test_aggregate_counts_free_space_of_all_inflight(monkeypatch):
    _quota(monkeypatch, 0)  # unlimited quota → free-space is the only limit
    _register("a")
    _register("b")
    reserve_export_quota("a", 60 * MB, free_bytes=100 * MB, volume="dev:1")
    with pytest.raises(InsufficientSpace):
        reserve_export_quota("b", 60 * MB, free_bytes=100 * MB, volume="dev:1")


def test_free_space_reservations_are_scoped_per_volume(monkeypatch):
    _quota(monkeypatch, 0)
    _register("a")
    _register("b")
    reserve_export_quota("a", 80 * MB, free_bytes=100 * MB, volume="dev:C")
    # A reservation on C: must not consume D:'s free-space admission budget.
    reserve_export_quota("b", 80 * MB, free_bytes=100 * MB, volume="dev:D")
    assert jobmod.JOBS["b"].est_bytes == 80 * MB


def test_browser_and_server_exports_share_one_volume_reservation(monkeypatch):
    _quota(monkeypatch, 0)
    reserve_external_output("browser", 60 * MB, 100 * MB, "dev:shared")
    _register("server")
    with pytest.raises(InsufficientSpace):
        reserve_export_quota(
            "server", 60 * MB, free_bytes=100 * MB, volume="dev:shared"
        )

    update_external_output_written("browser", 50 * MB)
    reserve_export_quota(
        "server", 60 * MB, free_bytes=100 * MB, volume="dev:shared"
    )
    release_external_output("browser")


def test_auxiliary_reservation_can_expand_atomically_and_counts_jobs_quota(monkeypatch):
    _quota(monkeypatch, 100)
    reserve_external_output(
        "separate-x",
        40 * MB,
        200 * MB,
        "dev:work",
        counts_toward_jobs_quota=True,
        store_path="/work/separate/x",
    )
    reserve_external_output(
        "separate-x",
        80 * MB,
        200 * MB,
        "dev:work",
        counts_toward_jobs_quota=True,
        store_path="/work/separate/x",
    )
    assert jobmod._EXTERNAL_OUTPUT_RESERVATIONS["separate-x"].estimated_bytes == 80 * MB
    with pytest.raises(QuotaExceeded):
        reserve_external_output(
            "separate-y",
            30 * MB,
            200 * MB,
            "dev:work",
            counts_toward_jobs_quota=True,
            store_path="/work/separate/y",
        )


def test_remaining_reservation_after_temp_write_admits_second_export(tmp_path, monkeypatch):
    """disk free already reflects written temp; remaining est = est − written.

    A: est 60 MB, already wrote 50 MB → remaining 10 MB.
    free 50 MB, B wants 30 MB → need 10+30=40 ≤ 50 → admit.
    Old bug: counted full 60+30=90 against free 50 → false 507.
    """
    _quota(monkeypatch, 0)
    _register("a", status="running", est=60 * MB)
    jobmod.JOBS["a"].est_volume = "dev:1"
    # Sparse/preallocated temp: set size without filling the host disk.
    temp = tmp_path / "a.temp.mp4"
    with open(temp, "wb") as f:
        f.truncate(50 * MB)
    jobmod.JOBS["a"].temp_path = str(temp)

    _register("b")
    reserve_export_quota("b", 30 * MB, free_bytes=50 * MB, volume="dev:1")
    assert jobmod.JOBS["b"].est_bytes == 30 * MB


def test_written_temp_still_counts_fully_against_jobs_quota(tmp_path, monkeypatch):
    """Logical jobs quota counts eventual outputs, not only bytes left to write."""
    _quota(monkeypatch, 70)
    _register("a", status="running", est=60 * MB)
    jobmod.JOBS["a"].est_volume = "dev:work"
    temp = tmp_path / "a.temp.mp4"
    with open(temp, "wb") as f:
        f.truncate(50 * MB)
    jobmod.JOBS["a"].temp_path = str(temp)
    _register("b")
    with pytest.raises(QuotaExceeded):
        reserve_export_quota("b", 30 * MB, free_bytes=100 * MB, volume="dev:work")


def test_finished_store_footprint_counts_against_quota(monkeypatch):
    _quota(monkeypatch, 70)
    monkeypatch.setattr(jobmod, "_jobs_store_committed_snapshot", lambda: (30 * MB, {}))
    _register("b")
    with pytest.raises(QuotaExceeded):
        reserve_export_quota("b", 50 * MB, free_bytes=500 * MB, volume="dev:work")


def test_scratch_reservation_aggregates_with_output_on_same_volume(monkeypatch):
    _quota(monkeypatch, 0)
    _register("a", status="running", est=60 * MB)
    jobmod.JOBS["a"].est_volume = "dev:work"
    _register("b")
    with pytest.raises(InsufficientSpace):
        reserve_export_scratch("b", 50 * MB, free_bytes=100 * MB, volume="dev:work")
    assert jobmod.JOBS["b"].est_scratch_bytes == 0


def test_no_temp_written_still_rejects_when_full_est_over_free(monkeypatch):
    """Without progress on A, remaining is full est → B still blocked as before."""
    _quota(monkeypatch, 0)
    _register("a", status="running", est=60 * MB)
    jobmod.JOBS["a"].est_volume = "dev:1"
    jobmod.JOBS["a"].temp_path = ""  # nothing written yet

    _register("b")
    with pytest.raises(InsufficientSpace):
        reserve_export_quota("b", 30 * MB, free_bytes=50 * MB, volume="dev:1")
    assert jobmod.JOBS["b"].est_bytes == 0


def test_external_export_does_not_consume_jobs_store_quota(monkeypatch):
    """User-chosen output folder only competes for free space, not XINCHAO_JOBS_QUOTA."""
    _quota(monkeypatch, 50)  # 50 MB jobs store
    _register("ext")
    # 80 MB external would fail if counted toward jobs quota.
    reserve_export_quota(
        "ext",
        80 * MB,
        free_bytes=200 * MB,
        volume="dev:ext",
        counts_toward_jobs_quota=False,
    )
    assert jobmod.JOBS["ext"].est_bytes == 80 * MB
    # Internal export still has the full 50 MB jobs budget free.
    _register("int")
    reserve_export_quota(
        "int",
        40 * MB,
        free_bytes=200 * MB,
        volume="dev:work",
        counts_toward_jobs_quota=True,
    )
    assert jobmod.JOBS["int"].est_bytes == 40 * MB


def test_terminal_job_directory_size_is_cached(tmp_path, monkeypatch):
    from app.config import get_settings

    monkeypatch.setenv("XINCHAO_WORK_DIR", str(tmp_path / "work"))
    get_settings.cache_clear()
    monkeypatch.setattr(jobmod, "_jobs_store_committed_snapshot", _REAL_JOBS_STORE_SNAPSHOT)
    terminal = tmp_path / "work" / "exports" / "done-job"
    terminal.mkdir(parents=True)
    (terminal / "out.mp4").write_bytes(b"x" * 1024)
    jobmod._TERMINAL_DIR_SIZE_CACHE.clear()
    real_dir_size = jobmod._dir_size
    calls: list[str] = []

    def counted(path: str) -> int:
        calls.append(path)
        return real_dir_size(path)

    monkeypatch.setattr(jobmod, "_dir_size", counted)
    assert _REAL_JOBS_STORE_SNAPSHOT()[0] == 1024
    assert _REAL_JOBS_STORE_SNAPSHOT()[0] == 1024
    assert calls == [str(terminal)]
    get_settings.cache_clear()


# ── router glue ──────────────────────────────────────────────────────────────

def test_reserve_maps_quota_to_413(monkeypatch):
    _register("j1")
    monkeypatch.setattr(
        ex, "reserve_export_quota", lambda *_a, **_k: (_ for _ in ()).throw(QuotaExceeded("x"))
    )
    monkeypatch.setattr(ex, "get_settings", lambda: types.SimpleNamespace(work_dir="/tmp"))
    with pytest.raises(HTTPException) as e:
        ex._reserve_output_or_413("j1", 5 * MB, None)
    assert e.value.status_code == 413


def test_reserve_maps_space_to_507(monkeypatch):
    _register("j1")
    monkeypatch.setattr(
        ex, "reserve_export_quota", lambda *_a, **_k: (_ for _ in ()).throw(InsufficientSpace("x"))
    )
    monkeypatch.setattr(ex, "get_settings", lambda: types.SimpleNamespace(work_dir="/tmp"))
    with pytest.raises(HTTPException) as e:
        ex._reserve_output_or_413("j1", 5 * MB, None)
    assert e.value.status_code == 507


def test_free_bytes_probes_nearest_existing_ancestor(tmp_path):
    missing = tmp_path / "does" / "not" / "exist"
    free = ex._free_bytes_on_volume(str(missing))
    assert free is not None and free > 0
