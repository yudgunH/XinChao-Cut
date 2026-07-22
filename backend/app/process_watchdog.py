"""Watch text-producing child processes without blocking forever on a pipe."""
from __future__ import annotations

import queue
import threading
import time
from collections.abc import Callable, Iterator
from typing import TextIO


class ProcessWatchdogTimeout(RuntimeError):
    """Raised after a child exceeds its wall-clock or no-output deadline."""


_EOF = object()


def iter_process_lines(
    proc,
    stream: TextIO,
    *,
    hard_timeout_sec: float,
    idle_timeout_sec: float,
    kill: Callable[[object], None],
    cancel_check: Callable[[], bool] | None = None,
) -> Iterator[str]:
    """Yield lines while enforcing hard and no-output deadlines.

    Reading a pipe directly can wait forever when ffmpeg or a driver wedges. A
    daemon reader owns that blocking operation while this iterator periodically
    checks deadlines and cancellation on the caller thread.
    """
    lines: queue.Queue[object] = queue.Queue()

    def _read() -> None:
        try:
            for line in stream:
                lines.put(line)
        finally:
            lines.put(_EOF)

    threading.Thread(target=_read, daemon=True, name="process-pipe-reader").start()
    started = last_output = time.monotonic()

    while True:
        now = time.monotonic()
        reason: str | None = None
        if cancel_check is not None and cancel_check():
            reason = "process cancelled"
        elif hard_timeout_sec > 0 and now - started >= hard_timeout_sec:
            reason = f"process exceeded {hard_timeout_sec:.0f}s wall-clock deadline"
        elif idle_timeout_sec > 0 and now - last_output >= idle_timeout_sec:
            reason = f"process produced no progress for {idle_timeout_sec:.0f}s"
        if reason is not None:
            kill(proc)
            raise ProcessWatchdogTimeout(reason)

        try:
            item = lines.get(timeout=0.25)
        except queue.Empty:
            if proc.poll() is not None:
                # Give the reader one final chance to publish buffered output.
                try:
                    item = lines.get(timeout=0.1)
                except queue.Empty:
                    return
            else:
                continue
        if item is _EOF:
            return
        last_output = time.monotonic()
        yield str(item)
