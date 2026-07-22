"""#14: BrokenPipe restart must tree-kill the old OmniVoice before spawning."""
from __future__ import annotations

from unittest.mock import MagicMock

import pytest


@pytest.fixture()
def tts_mgr(monkeypatch, tmp_path):
    monkeypatch.setenv("XINCHAO_WORK_DIR", str(tmp_path))
    from app.config import get_settings

    get_settings.cache_clear()
    from app.routers import tts as T

    mgr = T._WorkerManager()
    yield T, mgr, tmp_path
    try:
        mgr._shutdown_locked()
    except Exception:
        pass
    get_settings.cache_clear()


def test_broken_pipe_shuts_down_before_restart(tts_mgr, monkeypatch):
    T, mgr, tmp_path = tts_mgr

    old_proc = MagicMock()
    old_proc.poll.return_value = None
    old_proc.stdin = MagicMock()
    old_proc.pid = 4242
    mgr._proc = old_proc

    send_n = {"n": 0}
    status = tmp_path / "st.json"

    def fake_send(cmd, spec):
        send_n["n"] += 1
        if send_n["n"] == 1:
            raise BrokenPipeError("pipe closed")
        # After successful restart send, mark job done so submit exits the poll.
        T._write_status(str(status), {"status": "done"})

    order: list[str] = []

    def fake_shutdown():
        order.append("shutdown")
        mgr._proc = None

    def fake_start(py):
        order.append("start")
        # Must not leave the previous process referenced as live.
        assert mgr._proc is None
        new = MagicMock()
        new.poll.return_value = None
        new.stdin = MagicMock()
        new.pid = 9999
        mgr._proc = new

    monkeypatch.setattr(mgr, "_send", fake_send)
    monkeypatch.setattr(mgr, "_shutdown_locked", fake_shutdown)
    monkeypatch.setattr(mgr, "_start", fake_start)
    monkeypatch.setattr(
        mgr, "_alive", lambda: mgr._proc is not None and mgr._proc.poll() is None
    )

    mgr.submit("python", "synth", str(tmp_path / "spec.json"), str(status), timeout=5)

    assert "shutdown" in order
    assert "start" in order
    assert order.index("shutdown") < order.index("start")
    assert mgr._proc is not None
    assert mgr._proc.pid == 9999


def test_start_cleans_live_process_first(tts_mgr, monkeypatch):
    T, mgr, tmp_path = tts_mgr

    old = MagicMock()
    old.poll.side_effect = [None, None, 0, 0]  # alive until killed
    old.stdin = MagicMock()
    old.pid = 111
    old.wait = MagicMock()
    mgr._proc = old

    killed: list[int] = []
    monkeypatch.setattr(T, "_kill_process_tree", lambda p: killed.append(getattr(p, "pid", -1)))

    import app.routers.transcribe as tr_mod
    import app.gpu_guard as gg

    monkeypatch.setattr(tr_mod, "free_asr_vram", lambda only_if_large=True: None)
    monkeypatch.setattr(gg, "wait_for_vram", lambda *a, **k: True)

    new_proc = MagicMock()
    new_proc.poll.return_value = None
    new_proc.stdin = MagicMock()
    new_proc.pid = 222

    monkeypatch.setattr(T.subprocess, "Popen", lambda *a, **k: new_proc)

    with mgr._lock:
        mgr._start("python")

    assert 111 in killed
    assert mgr._proc is new_proc


def test_submit_cancel_waits_for_worker_ack_before_return(tts_mgr, monkeypatch):
    T, mgr, tmp_path = tts_mgr
    proc = MagicMock()
    proc.poll.return_value = None
    proc.stdin = MagicMock()
    proc.pid = 333
    mgr._proc = proc
    monkeypatch.setattr(mgr, "_send", lambda *_a: None)

    states = iter([None, {"status": "cancelled"}])
    monkeypatch.setattr(T, "_read_status", lambda _p: next(states))
    cancel_file = tmp_path / "cancel"

    mgr.submit(
        "python",
        "synth",
        str(tmp_path / "spec.json"),
        str(tmp_path / "status.json"),
        timeout=5,
        cancel_check=lambda: True,
        cancel_file=str(cancel_file),
    )

    assert cancel_file.exists()


def test_submit_force_kills_when_cancel_is_not_acknowledged(tts_mgr, monkeypatch):
    T, mgr, tmp_path = tts_mgr
    proc = MagicMock()
    proc.poll.return_value = None
    proc.stdin = MagicMock()
    proc.pid = 444
    mgr._proc = proc
    monkeypatch.setattr(mgr, "_send", lambda *_a: None)
    monkeypatch.setattr(T, "_read_status", lambda _p: None)
    monkeypatch.setattr(T, "WORKER_CANCEL_GRACE", 0)
    clock = {"value": 0.0}

    def tick():
        clock["value"] += 1.0
        return clock["value"]

    monkeypatch.setattr(T.time, "time", tick)
    killed: list[int] = []

    def shutdown():
        killed.append(proc.pid)
        mgr._proc = None

    monkeypatch.setattr(mgr, "_shutdown_locked", shutdown)
    status = tmp_path / "status.json"
    mgr.submit(
        "python",
        "synth",
        str(tmp_path / "spec.json"),
        str(status),
        timeout=30,
        cancel_check=lambda: True,
        cancel_file=str(tmp_path / "cancel"),
    )

    assert killed == [444]
    assert T._read_status(str(status)) is None  # monkeypatched reader stays isolated
    import json

    assert json.loads(status.read_text(encoding="utf-8"))["status"] == "cancelled"
