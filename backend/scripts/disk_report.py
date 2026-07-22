"""Report (and optionally reclaim) disk used by backend/.work.

Usage (plain report needs only stdlib):
    python backend/scripts/disk_report.py

Reclaim space (run with the backend venv so app imports resolve):
    backend/.venv/Scripts/python backend/scripts/disk_report.py --clean
    backend/.venv/Scripts/python backend/scripts/disk_report.py --purge-jobs

  --clean        run the same TTL+quota cleanup the server does at startup.
                 Safe — bounded eviction, never deletes live jobs.
  --purge-jobs   delete ALL editor job outputs (exports/proxies/separate/tts).
                 Keeps models, hf-cache, voices and assets.
"""
from __future__ import annotations

import os
import shutil
import sys

# Vietnamese labels below would crash on a cp1252 Windows console — force UTF-8.
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

BACKEND_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# Follow a relocated work dir (packaged launcher sets XINCHAO_WORK_DIR); else the dev
# default backend/.work. Mirrors app.config so the report targets the real data.
_env_work = os.environ.get("XINCHAO_WORK_DIR")
WORK = os.path.abspath(_env_work) if _env_work else os.path.join(BACKEND_ROOT, ".work")

# Which subdirs are safe to wipe (regenerated on demand) vs must be kept.
KEEP = {"models", "hf-cache", "voices", "jobs.db"}
SAFE = {"exports", "proxies", "separate", "tts", "assets"}


def dir_size(path: str) -> int:
    total = 0
    for root, _dirs, files in os.walk(path):
        for f in files:
            try:
                total += os.path.getsize(os.path.join(root, f))
            except OSError:
                pass
    return total


def human(n: int) -> str:
    f = float(n)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if f < 1024 or unit == "TB":
            return f"{f:.1f}{unit}"
        f /= 1024
    return f"{f:.1f}TB"


def _tag(name: str) -> str:
    return "GIỮ" if name in KEEP else ("an toàn xoá" if name in SAFE else "?")


def report() -> None:
    if not os.path.isdir(WORK):
        print(f"(no work dir at {WORK})")
        return
    rows = []
    total = 0
    for name in sorted(os.listdir(WORK)):
        p = os.path.join(WORK, name)
        size = dir_size(p) if os.path.isdir(p) else (os.path.getsize(p) if os.path.isfile(p) else 0)
        total += size
        rows.append((size, name, _tag(name)))
    print(f"{'work dir':38} {WORK}")
    print("-" * 64)
    for size, name, tag in sorted(rows, reverse=True):
        print(f"  {name:20} {human(size):>9}   [{tag}]")
    print("-" * 64)
    print(f"  {'TỔNG':20} {human(total):>9}")
    print("\nGIỮ = model/giọng/kết quả cần thiết · an toàn xoá = cache/scratch tự tạo lại")
    print("Dọn an toàn:   python backend/scripts/disk_report.py --clean        (chạy bằng backend/.venv)")


def run_clean() -> None:
    sys.path.insert(0, BACKEND_ROOT)
    from app.routers.assets import cleanup_assets
    from app.export.job import cleanup_job_dirs
    print("Running asset store cleanup (TTL+quota)…")
    cleanup_assets()
    print("Running job-dir cleanup (TTL+quota)…")
    n = cleanup_job_dirs()
    print(f"Evicted {n} editor job dir(s).")
    print("New state:\n")
    report()


def run_purge_jobs() -> None:
    removed = 0
    for sub in ("exports", "proxies", "separate", "tts"):
        p = os.path.join(WORK, sub)
        if os.path.isdir(p):
            shutil.rmtree(p, ignore_errors=True)
            removed += 1
    print(f"Purged {removed} job output dir(s) (kept models/hf-cache/voices/assets).\n")
    report()


def main() -> int:
    if "--purge-jobs" in sys.argv:
        run_purge_jobs()
    elif "--clean" in sys.argv:
        run_clean()
    else:
        report()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
