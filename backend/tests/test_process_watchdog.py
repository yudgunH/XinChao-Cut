from __future__ import annotations

import time

import pytest

from app.process_watchdog import ProcessWatchdogTimeout, iter_process_lines


class _StalledProc:
    killed = False

    def poll(self):
        return -9 if self.killed else None


def test_idle_watchdog_kills_a_process_whose_pipe_stalls():
    proc = _StalledProc()

    def stalled_stream():
        time.sleep(2)
        yield "too late\n"

    def kill(target):
        target.killed = True

    with pytest.raises(ProcessWatchdogTimeout, match="no progress"):
        list(
            iter_process_lines(
                proc,
                stalled_stream(),
                hard_timeout_sec=1,
                idle_timeout_sec=0.05,
                kill=kill,
            )
        )
    assert proc.killed is True


def test_watchdog_yields_complete_stream_without_killing():
    proc = _StalledProc()
    lines = list(
        iter_process_lines(
            proc,
            iter(["a\n", "b\n"]),
            hard_timeout_sec=1,
            idle_timeout_sec=1,
            kill=lambda target: setattr(target, "killed", True),
        )
    )
    assert lines == ["a\n", "b\n"]
    assert proc.killed is False
