"""S5 — unified ResourceCoordinator: concurrency, cancel, fairness, nested."""
from __future__ import annotations

import threading
import time

import pytest

from app.resource_coordinator import (
    AcquireCancelledError,
    NestedAcquireError,
    ResourceCoordinator,
    ResourceKind,
    SemaphoreFacade,
    get_coordinator,
    resource_guard,
    set_coordinator,
)


@pytest.fixture(autouse=True)
def _fresh_coord():
    set_coordinator(ResourceCoordinator())
    yield
    set_coordinator(None)


def test_concurrency_does_not_exceed_limit():
    coord = get_coordinator()
    active = 0
    peak = 0
    lock = threading.Lock()
    started = threading.Barrier(3)

    def worker(i: int) -> None:
        nonlocal active, peak
        started.wait(timeout=5)  # all race to acquire together
        with resource_guard(ResourceKind.GPU_MODEL, owner=f"w{i}"):
            with lock:
                active += 1
                peak = max(peak, active)
            time.sleep(0.08)
            with lock:
                active -= 1

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(3)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=10)
    assert peak == 1
    assert coord.pool_free() == 1


def test_cancel_waiter_does_not_leak_permit():
    coord = get_coordinator()
    held = threading.Event()
    release_holder = threading.Event()

    def holder() -> None:
        with resource_guard(ResourceKind.HW_ENCODER, owner="holder"):
            held.set()
            release_holder.wait(timeout=5)

    th = threading.Thread(target=holder, daemon=True)
    th.start()
    assert held.wait(timeout=2)

    cancel_ev = threading.Event()
    err: list[BaseException] = []

    def waiter() -> None:
        try:
            with resource_guard(
                ResourceKind.GPU_MODEL,
                cancel_event=cancel_ev,
                owner="waiter",
            ):
                err.append(RuntimeError("should not acquire"))
        except AcquireCancelledError as e:
            err.append(e)

    tw = threading.Thread(target=waiter, daemon=True)
    tw.start()
    time.sleep(0.1)  # ensure waiter is queued
    m = coord.metrics()
    assert m["pools"]["heavy"]["waiting"] >= 1
    cancel_ev.set()
    tw.join(timeout=5)
    assert len(err) == 1 and isinstance(err[0], AcquireCancelledError)

    # Holder still owns the only permit; free stays 0 until release.
    assert coord.pool_free() == 0
    release_holder.set()
    th.join(timeout=5)
    assert coord.pool_free() == 1
    assert coord.metrics()["pools"]["heavy"]["totalCancels"] >= 1


def test_exception_in_holder_releases_permit():
    with pytest.raises(RuntimeError, match="boom"):
        with resource_guard(ResourceKind.HEAVY_CPU, owner="boom"):
            raise RuntimeError("boom")
    assert get_coordinator().pool_free() == 1

    # Next acquire must succeed immediately.
    with resource_guard(ResourceKind.GPU_MODEL, owner="next"):
        assert get_coordinator().pool_free() == 0
    assert get_coordinator().pool_free() == 1


def test_nested_acquire_same_pool_raises():
    with resource_guard(ResourceKind.GPU_MODEL, owner="outer"):
        with pytest.raises(NestedAcquireError):
            with resource_guard(ResourceKind.HW_ENCODER, owner="inner"):
                pass
    assert get_coordinator().pool_free() == 1


def test_gpu_model_and_hw_encoder_share_pool():
    """TTS (gpu_model) and Editor export (hw_encoder) must not run together."""
    order: list[str] = []
    lock = threading.Lock()
    go = threading.Event()

    def tts() -> None:
        with resource_guard(ResourceKind.GPU_MODEL, owner="tts"):
            with lock:
                order.append("tts-enter")
            go.wait(timeout=2)
            time.sleep(0.05)
            with lock:
                order.append("tts-exit")

    def export() -> None:
        # Start slightly after tts is holding.
        time.sleep(0.02)
        with resource_guard(ResourceKind.HW_ENCODER, owner="editor-export"):
            with lock:
                order.append("export-enter")
            with lock:
                order.append("export-exit")

    a = threading.Thread(target=tts)
    b = threading.Thread(target=export)
    a.start()
    b.start()
    time.sleep(0.05)
    go.set()
    a.join(timeout=5)
    b.join(timeout=5)
    # export cannot enter while tts holds; so exit order is tts then export.
    assert order.index("tts-enter") < order.index("tts-exit")
    assert order.index("tts-exit") <= order.index("export-enter")


def test_whisperx_and_demucs_gpu_model_do_not_overlap():
    """#5: WhisperX (run_transcription_sync) and Demucs both take GPU_MODEL —
    peak concurrent holders must stay 1 (not HEAVY_CPU-only vs independent lock)."""
    active = 0
    peak = 0
    lock = threading.Lock()
    barrier = threading.Barrier(2)

    def whisperx_like() -> None:
        nonlocal active, peak
        barrier.wait(timeout=5)
        with resource_guard(ResourceKind.GPU_MODEL, owner="whisperx-transcribe-sync"):
            with lock:
                active += 1
                peak = max(peak, active)
            time.sleep(0.12)
            with lock:
                active -= 1

    def demucs_like() -> None:
        nonlocal active, peak
        barrier.wait(timeout=5)
        with resource_guard(ResourceKind.GPU_MODEL, owner="demucs:test-job"):
            with lock:
                active += 1
                peak = max(peak, active)
            time.sleep(0.12)
            with lock:
                active -= 1

    threads = [
        threading.Thread(target=whisperx_like),
        threading.Thread(target=demucs_like),
    ]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=10)
    assert peak == 1
    assert get_coordinator().pool_free() == 1


def test_whisperx_gpu_serializes_with_review_tts():
    """WhisperX and OmniVoice GPU_MODEL work never overlaps."""
    order: list[str] = []
    lock = threading.Lock()
    hold = threading.Event()

    def whisper() -> None:
        with resource_guard(ResourceKind.GPU_MODEL, owner="whisperx-transcribe-sync"):
            with lock:
                order.append("w-enter")
            hold.wait(timeout=3)
            with lock:
                order.append("w-exit")

    def tts() -> None:
        time.sleep(0.03)
        with resource_guard(ResourceKind.GPU_MODEL, owner="tts-gpu"):
            with lock:
                order.append("t-enter")
            with lock:
                order.append("t-exit")

    a = threading.Thread(target=whisper)
    b = threading.Thread(target=tts)
    a.start()
    b.start()
    time.sleep(0.08)
    hold.set()
    a.join(timeout=5)
    b.join(timeout=5)
    assert order.index("w-exit") <= order.index("t-enter")


def test_fifo_fairness_queue_ordering():
    """Head-of-line waiter is granted first (FIFO contract)."""
    coord = get_coordinator()
    release_holder = threading.Event()
    granted: list[str] = []
    g_lock = threading.Lock()

    def holder() -> None:
        with resource_guard(ResourceKind.GPU_MODEL, owner="H"):
            release_holder.wait(timeout=5)

    th = threading.Thread(target=holder, daemon=True)
    th.start()
    time.sleep(0.05)

    def waiter(name: str, delay: float) -> None:
        time.sleep(delay)
        with resource_guard(ResourceKind.HEAVY_CPU, owner=name):
            with g_lock:
                granted.append(name)

    # Enqueue A then B (A first).
    ta = threading.Thread(target=waiter, args=("A", 0.0), daemon=True)
    tb = threading.Thread(target=waiter, args=("B", 0.05), daemon=True)
    ta.start()
    time.sleep(0.03)
    tb.start()
    time.sleep(0.1)
    m = coord.metrics()
    assert m["pools"]["heavy"]["waiting"] == 2
    release_holder.set()
    th.join(timeout=5)
    ta.join(timeout=5)
    tb.join(timeout=5)
    assert granted == ["A", "B"]


def test_semaphore_facade_acquire_release_and_value():
    sem = SemaphoreFacade(ResourceKind.HEAVY_CPU)
    assert sem._value == 1
    assert sem.acquire(timeout=1.0) is True
    assert sem._value == 0
    # Second acquire times out
    assert sem.acquire(timeout=0.1) is False
    sem.release()
    assert sem._value == 1
    with pytest.raises(ValueError):
        sem.release()


def test_permit_release_idempotent():
    p = get_coordinator().acquire(ResourceKind.GPU_MODEL, owner="x")
    p.release()
    p.release()  # no raise
    assert get_coordinator().pool_free() == 1


def test_three_way_contention_export_render_tts():
    """Simultaneous render, Editor export and TTS work has peak active == 1."""
    peak = 0
    active = 0
    lock = threading.Lock()
    kinds = [
        (ResourceKind.HW_ENCODER, "export"),
        (ResourceKind.HW_ENCODER, "render"),
        (ResourceKind.GPU_MODEL, "tts"),
    ]
    start = threading.Barrier(3)

    def run(kind: ResourceKind, name: str) -> None:
        nonlocal peak, active
        start.wait(timeout=5)
        with resource_guard(kind, owner=name):
            with lock:
                active += 1
                peak = max(peak, active)
            time.sleep(0.06)
            with lock:
                active -= 1

    threads = [threading.Thread(target=run, args=k) for k in kinds]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=10)
    assert peak == 1


def test_metrics_snapshot_shape():
    with resource_guard(ResourceKind.GPU_MODEL, owner="m"):
        m = get_coordinator().metrics()
        assert "pools" in m
        assert m["pools"]["heavy"]["active"] == 1
        assert m["pools"]["heavy"]["free"] == 0
        assert m["kindToPool"]["gpu_model"] == "heavy"
        assert m["kindToPool"]["hw_encoder"] == "heavy"


def _wait_for_queued(coord: ResourceCoordinator, pool_name: str = "heavy") -> None:
    pool = coord._get_pool(pool_name)
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        with pool.condition:
            if pool.waiters:
                return
        time.sleep(0.001)
    raise AssertionError("waiter never enqueued")


def test_grant_then_cancel_race_returns_permit_instead_of_leaking():
    """Permit-leak regression: cancel racing an already-committed grant.

    _grant_waiters commits the slot (active++/holders++) before the waiter
    wakes. If cancel_event was set in that same window, the old code raised
    AcquireCancelledError from the wait loop WITHOUT releasing the committed
    slot — permanently exhausting the limit-1 heavy pool (every later export/
    demucs/tts queued forever until a backend restart). Real trigger:
    preempt_proxies() cancels a queued proxy at the same instant the running
    proxy finishes and grants it.

    Deterministic interleave: the waiter only evaluates cancel/granted while
    holding pool.condition, so committing BOTH the cancel_event and the release
    (grant) under that lock guarantees the waiter observes them together.
    """
    coord = get_coordinator()
    p1 = coord.acquire(ResourceKind.GPU_MODEL, owner="running-job")

    cancel_ev = threading.Event()
    outcome: dict = {}

    def waiter() -> None:
        try:
            permit = coord.acquire(
                ResourceKind.GPU_MODEL, cancel_event=cancel_ev, owner="queued-job",
            )
            outcome["granted"] = True
            # Real callers re-check their cancel flag here and bail out —
            # releasing via finally/context-manager either way.
            permit.release()
        except AcquireCancelledError:
            outcome["cancelled"] = True

    th = threading.Thread(target=waiter, daemon=True)
    th.start()
    _wait_for_queued(coord)

    pool = coord._get_pool("heavy")
    with pool.condition:  # waiter cannot wake while we hold the condition
        cancel_ev.set()
        p1.release()  # grants the (just-cancelled) waiter under the same lock
    th.join(timeout=5)
    assert not th.is_alive()

    # The slot must come back either way; with the fix the waiter receives the
    # permit (and releases it) instead of abandoning a committed grant.
    assert outcome == {"granted": True}
    assert coord.pool_free() == 1
    assert not pool.holders


def test_cancel_before_grant_still_raises_and_frees_queue():
    """Cancel observed before any grant keeps the old semantics: raise, no permit."""
    coord = get_coordinator()
    p1 = coord.acquire(ResourceKind.GPU_MODEL, owner="running-job")

    cancel_ev = threading.Event()
    outcome: dict = {}

    def waiter() -> None:
        try:
            coord.acquire(
                ResourceKind.GPU_MODEL, cancel_event=cancel_ev, owner="queued-job",
            )
            outcome["granted"] = True
        except AcquireCancelledError:
            outcome["cancelled"] = True

    th = threading.Thread(target=waiter, daemon=True)
    th.start()
    _wait_for_queued(coord)

    cancel_ev.set()
    th.join(timeout=5)  # waiter polls cancel every 50ms and removes itself
    assert not th.is_alive()
    assert outcome == {"cancelled": True}

    pool = coord._get_pool("heavy")
    with pool.condition:
        assert not pool.waiters  # queue is clean; p1 still holds the only slot
    assert coord.pool_free() == 0
    p1.release()
    assert coord.pool_free() == 1
