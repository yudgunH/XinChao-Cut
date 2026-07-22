from __future__ import annotations

import threading
import time

from app.export import chunk_runner


def _manifest(count: int, parallel: int) -> dict:
    return {
        "totalDuration": float(count),
        "maxParallel": parallel,
        "stages": [
            {
                "cmd": ["ffmpeg"],
                "duration": 1.0,
                "offset": float(index),
                "cwd": ".",
            }
            for index in range(count)
        ],
    }


def test_parallel_runner_respects_bound_and_reports_monotonic_progress(
    monkeypatch, capsys
):
    active = 0
    peak = 0
    lock = threading.Lock()

    def fake_run(_cmd, duration, _offset, _cwd, on_progress=None):
        nonlocal active, peak
        with lock:
            active += 1
            peak = max(peak, active)
        try:
            on_progress(duration / 2)
            time.sleep(0.02)
            on_progress(duration)
            return 0
        finally:
            with lock:
                active -= 1

    monkeypatch.setattr(chunk_runner, "_run_stage", fake_run)
    assert chunk_runner._run_stages(_manifest(4, 2)) == 0
    assert peak == 2
    values = [
        int(line.split("=", 1)[1])
        for line in capsys.readouterr().out.splitlines()
        if line.startswith("out_time_us=")
    ]
    assert values == sorted(set(values))
    assert values[-1] == 4_000_000


def test_parallel_runner_stops_siblings_after_first_failure(monkeypatch):
    calls = 0
    lock = threading.Lock()

    def fake_run(_cmd, _duration, offset, _cwd, on_progress=None):
        nonlocal calls
        with lock:
            calls += 1
        if offset == 0:
            return 7
        while not chunk_runner._STOP.wait(0.005):
            pass
        return 1

    monkeypatch.setattr(chunk_runner, "_run_stage", fake_run)
    monkeypatch.setattr(chunk_runner, "_kill_all_active", lambda: None)
    assert chunk_runner._run_stages(_manifest(8, 2)) == 7
    assert calls <= 2
