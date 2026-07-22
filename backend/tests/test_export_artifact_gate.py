from __future__ import annotations

import time
from contextlib import contextmanager

import pytest


def _encoded_file(tmp_path):
    path = tmp_path / "render.part.mp4"
    path.write_bytes(b"x" * 512)
    return path


def test_export_artifact_gate_accepts_expected_streams(tmp_path, monkeypatch):
    from app.export import artifact

    path = _encoded_file(tmp_path)
    monkeypatch.setattr(
        artifact,
        "probe",
        lambda _path: {"durationSec": 60.1, "hasVideo": True, "hasAudio": True},
    )
    result = artifact.validate_export_artifact(
        str(path),
        expected_duration=60.0,
        expect_audio=True,
    )

    assert result["durationSec"] == 60.1
    assert result["hasAudio"] is True


@pytest.mark.parametrize(
    ("meta", "message"),
    [
        ({"durationSec": 60, "hasVideo": False, "hasAudio": True}, "video stream"),
        ({"durationSec": 45, "hasVideo": True, "hasAudio": True}, "duration mismatch"),
        ({"durationSec": 60, "hasVideo": True, "hasAudio": False}, "audio stream"),
    ],
)
def test_export_artifact_gate_rejects_broken_contract(
    tmp_path, monkeypatch, meta, message
):
    from app.export import artifact

    path = _encoded_file(tmp_path)
    monkeypatch.setattr(artifact, "probe", lambda _path: meta)

    with pytest.raises(artifact.ExportArtifactError, match=message):
        artifact.validate_export_artifact(
            str(path), expected_duration=60.0, expect_audio=True
        )


def test_export_expectations_detect_encoded_audio():
    from app.routers.export import _artifact_expectations

    result = _artifact_expectations(
        {},
        ["ffmpeg", "-c:a", "aac", "out.mp4"],
    )

    assert result["validateArtifact"] is True
    assert result["expectAudio"] is True


def test_export_job_does_not_publish_when_artifact_gate_fails(tmp_path, monkeypatch):
    from app.config import get_settings
    from app.export import artifact
    from app.export import job as jobs

    monkeypatch.setenv("XINCHAO_WORK_DIR", str(tmp_path / "work"))
    get_settings.cache_clear()
    jobs.JOBS.clear()

    class Proc:
        stdout = iter(())
        stderr = iter(())

        def wait(self, timeout=None):
            return 0

        def poll(self):
            return 0

    @contextmanager
    def immediate_guard(*_args, **_kwargs):
        yield

    monkeypatch.setattr(jobs.subprocess, "Popen", lambda *_a, **_k: Proc())
    monkeypatch.setattr(jobs, "resource_guard", immediate_guard)
    monkeypatch.setattr(jobs, "cleanup_job_dirs", lambda: None)
    monkeypatch.setattr(
        artifact,
        "validate_export_artifact",
        lambda *_a, **_k: (_ for _ in ()).throw(
            artifact.ExportArtifactError("invalid export artifact")
        ),
    )

    final = tmp_path / "final.mp4"
    final.write_bytes(b"")  # reserved destination
    temp = tmp_path / "render.part.mp4"
    temp.write_bytes(b"x" * 512)
    export_job = jobs.create_job(10, out_path=str(final), status="setup")
    export_job.temp_path = str(temp)
    export_job.reserved_out = True
    export_job.diag = {"validateArtifact": True}

    jobs.run_job(export_job, ["ffmpeg", "out.mp4"], cwd=str(tmp_path))
    deadline = time.monotonic() + 3
    while export_job.status in {"setup", "running"} and time.monotonic() < deadline:
        time.sleep(0.01)

    assert export_job.status == "error"
    assert "invalid export artifact" in (export_job.error or "")
    assert not final.exists()
    assert not temp.exists()

    jobs.JOBS.clear()
    get_settings.cache_clear()
