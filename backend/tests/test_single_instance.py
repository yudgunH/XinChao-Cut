"""The backend must refuse to run as a second process.

Export handles / cancel flags live in `export.job.JOBS` (per-process memory) and
in-memory workers claim queued rows without an atomic lease, so a second
process duplicates jobs and makes cancel/status route to the wrong worker.
"""
from __future__ import annotations

import subprocess
import sys
import textwrap

import pytest

from app import single_instance


@pytest.fixture(autouse=True)
def _release_after():
    yield
    single_instance.release()


def test_acquire_then_release_is_reusable(tmp_path):
    single_instance.acquire(tmp_path)
    assert single_instance.is_held()
    single_instance.release()
    assert not single_instance.is_held()
    # Re-acquirable once released.
    single_instance.acquire(tmp_path)
    assert single_instance.is_held()


def test_acquire_is_idempotent_within_a_process(tmp_path):
    single_instance.acquire(tmp_path)
    single_instance.acquire(tmp_path)  # no-op, must not raise
    assert single_instance.is_held()


def test_bypass_flag_skips_the_guard(tmp_path, monkeypatch):
    monkeypatch.setenv("XINCHAO_ALLOW_MULTI_PROCESS", "1")
    single_instance.acquire(tmp_path)
    # Bypassed → no handle held, so a sibling would also start.
    assert not single_instance.is_held()


def test_second_process_is_refused(tmp_path):
    """The real contract: another OS process cannot take the lock while we hold it."""
    single_instance.acquire(tmp_path)
    assert single_instance.is_held()

    child = subprocess.run(
        [
            sys.executable,
            "-c",
            textwrap.dedent(
                f"""
                import sys
                sys.path.insert(0, {str(_backend_root())!r})
                from app import single_instance
                try:
                    single_instance.acquire({str(tmp_path)!r})
                except single_instance.MultipleBackendProcesses:
                    print("REFUSED")
                else:
                    print("ACQUIRED")
                """
            ),
        ],
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert "REFUSED" in child.stdout, f"stdout={child.stdout!r} stderr={child.stderr!r}"


def test_lock_frees_when_holder_process_exits(tmp_path):
    """A crashed backend must not leave a stale lock (OS releases advisory locks)."""
    child = subprocess.run(
        [
            sys.executable,
            "-c",
            textwrap.dedent(
                f"""
                import sys
                sys.path.insert(0, {str(_backend_root())!r})
                from app import single_instance
                single_instance.acquire({str(tmp_path)!r})
                print("HELD")
                """
            ),
        ],
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert "HELD" in child.stdout, f"stderr={child.stderr!r}"
    # Child is gone → we can take it.
    single_instance.acquire(tmp_path)
    assert single_instance.is_held()


def _backend_root() -> str:
    from pathlib import Path

    return str(Path(__file__).resolve().parents[1])
