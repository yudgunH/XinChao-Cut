from __future__ import annotations

import subprocess
import sys

from app import gpu_guard


def test_cuda_free_mb_uses_nvidia_smi_when_torch_not_loaded(monkeypatch):
    monkeypatch.delitem(sys.modules, "torch", raising=False)
    monkeypatch.setattr(gpu_guard, "_nvidia_smi_free_mb", lambda: 742)

    assert gpu_guard.cuda_free_mb() == 742


def test_nvidia_smi_free_mb_parses_lowest_gpu(monkeypatch):
    def fake_run(*args, **kwargs):
        return subprocess.CompletedProcess(args[0], 0, stdout="584\n4096\n", stderr="")

    monkeypatch.setattr(gpu_guard.subprocess, "run", fake_run)

    assert gpu_guard._nvidia_smi_free_mb() == 584


def test_nvidia_smi_free_mb_fails_open_on_probe_error(monkeypatch):
    def fake_run(*args, **kwargs):
        raise FileNotFoundError("nvidia-smi")

    monkeypatch.setattr(gpu_guard.subprocess, "run", fake_run)

    assert gpu_guard._nvidia_smi_free_mb() is None
