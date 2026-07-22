"""A successful export must drop its input snapshot.

materialize_assets copies/hardlinks every source into job_dir/inputs; for an
external or cross-volume source that's a full copy of a multi-GB video. Success
cleanup used to remove only the temp + leases, leaving that copy in the work dir
until the 7-day / quota sweep — filling the work disk even when the output was
saved to another drive (#6).
"""
from __future__ import annotations

from types import SimpleNamespace

from app.export import integrity as ig


def _job_dir_with_inputs(tmp_path, name="job1"):
    jd = tmp_path / "exports" / name
    (jd / "inputs").mkdir(parents=True)
    (jd / "inputs" / "big.mp4").write_bytes(b"x" * 1024)
    (jd / "fonts").mkdir()
    (jd / "fonts" / "f.ttf").write_bytes(b"f")
    (jd / "filter-complex-job.txt").write_text("graph")
    return jd


def test_external_output_removes_whole_job_dir(tmp_path):
    jd = _job_dir_with_inputs(tmp_path)
    external = tmp_path / "user" / "out.mp4"
    external.parent.mkdir(parents=True)
    external.write_bytes(b"final")
    job = SimpleNamespace(job_dir=str(jd), out_path=str(external))

    ig._drop_export_scratch(job)

    assert not jd.exists()           # scratch gone
    assert external.exists()         # the downloadable final is untouched


def test_internal_output_keeps_final_drops_scratch(tmp_path):
    jd = _job_dir_with_inputs(tmp_path)
    final = jd / "out.mp4"
    final.write_bytes(b"final")
    job = SimpleNamespace(job_dir=str(jd), out_path=str(final))

    ig._drop_export_scratch(job)

    assert final.exists()                       # final kept
    assert not (jd / "inputs").exists()         # input snapshot dropped
    assert not (jd / "fonts").exists()
    assert not (jd / "filter-complex-job.txt").exists()


def test_cleanup_job_fs_success_invokes_scratch_drop(tmp_path):
    jd = _job_dir_with_inputs(tmp_path)
    final = jd / "out.mp4"
    final.write_bytes(b"final")
    job = SimpleNamespace(
        job_dir=str(jd), out_path=str(final), temp_path="", leased_paths=[], reserved_out=True,
    )
    ig.cleanup_job_fs(job, success=True)
    assert final.exists()
    assert not (jd / "inputs").exists()


def test_cleanup_job_fs_failure_drops_copied_inputs(tmp_path):
    jd = _job_dir_with_inputs(tmp_path)
    final = jd / "out.mp4"
    final.write_bytes(b"")
    job = SimpleNamespace(
        job_dir=str(jd), out_path=str(final), temp_path="", leased_paths=[], reserved_out=True,
    )
    ig.cleanup_job_fs(job, success=False)
    assert not (jd / "inputs").exists()
    assert not final.exists()


def test_no_job_dir_is_a_noop(tmp_path):
    job = SimpleNamespace(job_dir="", out_path="")
    ig._drop_export_scratch(job)  # must not raise


def test_copy_fallback_reserves_before_writing_destination(tmp_path, monkeypatch):
    src = tmp_path / "source.mp4"
    dest = tmp_path / "inputs" / "source.mp4"
    src.write_bytes(b"x" * 123)
    monkeypatch.setattr(ig.os, "link", lambda *_a: (_ for _ in ()).throw(OSError("no link")))
    seen: list[tuple[str, int, bool]] = []

    def before_copy(path: str, size: int) -> None:
        seen.append((path, size, dest.exists()))

    result = ig.materialize_input(str(src), str(dest), before_copy=before_copy)
    assert result.method == "copy"
    assert seen == [(str(src), 123, False)]
    assert dest.read_bytes() == src.read_bytes()
