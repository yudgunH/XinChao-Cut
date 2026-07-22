"""Central CPU/GPU resource coordinator (S5 / F04).

The backend runs export, proxy creation, source separation, ASR and TTS through
one coordinator so heavy work cannot corrupt model state or thrash VRAM.

This module owns **one** coordinator. Resource *kinds* are explicit for metrics
and call-site documentation, but GPU model + hardware encoder + heavy CPU all
map to the same pool (``heavy``) by default so there is again a single gate
(backward-compatible with the old limit=1 semaphore).

Ownership boundary (document — do not re-enter):
  * A thread must not nest ``acquire`` of the same pool (raises
    ``NestedAcquireError``). Holders should not call back into code that
    acquires again. Workers must not call another guarded operation while
    holding the permit.
  * Release is always in ``finally`` / context-manager exit; ``Permit.release``
    is idempotent so cancel + exception paths cannot double-free or leak.

Waiter cancel: pass ``cancel_event``; when set, the waiter is removed from the
FIFO queue **without** taking a permit (no leak, no effect on other jobs).
If the cancel races a grant that already committed the slot, ``acquire``
returns the permit anyway (never raises after commit — raising leaked the
permit forever). Callers must re-check their own cancel flag right after
acquiring and release via ``finally`` / context manager — every call site does.
"""
from __future__ import annotations

import logging
import os
import threading
import time
import uuid
from collections import deque
from contextlib import contextmanager
from dataclasses import dataclass, field
from enum import Enum
from typing import Callable, Deque, Dict, Iterator, List, Optional, Sequence

log = logging.getLogger(__name__)


class ResourceKind(str, Enum):
    """Logical resource classes requested by call sites."""

    # Torch / CUDA model inference (OmniVoice, WhisperX worker, Demucs, …)
    GPU_MODEL = "gpu_model"
    # Hardware video encode / heavy FFmpeg that may use NVENC on the same card
    HW_ENCODER = "hw_encoder"
    # CPU-bound heavy FFmpeg / filtergraphs (still serialised with GPU by default)
    HEAVY_CPU = "heavy_cpu"


# Default: one shared pool so GPU model + encoder + heavy ffmpeg never race.
_DEFAULT_POOL = "heavy"


def _pool_for(kind: ResourceKind) -> str:
    """Map logical kind → pool name.

    Override with ``XINCHAO_RESOURCE_SPLIT_CPU=1`` to put HEAVY_CPU on its own pool
    (advanced; default keeps full serialisation like the old single semaphore).
    """
    if kind == ResourceKind.HEAVY_CPU and os.environ.get("XINCHAO_RESOURCE_SPLIT_CPU", "").strip() in (
        "1", "true", "yes",
    ):
        return "heavy_cpu"
    return _DEFAULT_POOL


def _pool_limit(pool: str) -> int:
    if pool == "heavy_cpu":
        raw = os.environ.get("XINCHAO_RESOURCE_CPU_LIMIT", "1")
    else:
        raw = os.environ.get("XINCHAO_RESOURCE_HEAVY_LIMIT", os.environ.get("XINCHAO_HEAVY_JOB_LIMIT", "1"))
    try:
        n = int(raw)
    except ValueError:
        n = 1
    return max(1, n)


class NestedAcquireError(RuntimeError):
    """Same thread tried to re-acquire a pool it already holds."""


class AcquireTimeoutError(TimeoutError):
    """Timed out waiting for a resource permit."""


class AcquireCancelledError(Exception):
    """Waiter was cancelled before a permit was granted."""


@dataclass
class _Waiter:
    id: str
    thread_id: int
    kind: ResourceKind
    owner: str
    enqueued_at: float
    event: threading.Event = field(default_factory=threading.Event)
    cancelled: bool = False
    granted: bool = False
    cancel_event: Optional[threading.Event] = None


@dataclass
class _Pool:
    name: str
    limit: int
    active: int = 0
    condition: threading.Condition = field(default_factory=threading.Condition)
    waiters: Deque[_Waiter] = field(default_factory=deque)
    # thread id → reentrancy depth (we forbid >0 re-entry but track holders)
    holders: Dict[int, int] = field(default_factory=dict)
    # metrics
    total_acquires: int = 0
    total_wait_ms: float = 0.0
    total_timeouts: int = 0
    total_cancels: int = 0


class Permit:
    """Opaque handle for a granted acquisition. ``release()`` is idempotent."""

    __slots__ = ("_coord", "_pools", "_kind", "_owner", "_thread_id", "_released", "_wait_ms")

    def __init__(
        self,
        coord: "ResourceCoordinator",
        pools: Sequence[str],
        kind: ResourceKind,
        owner: str,
        thread_id: int,
        wait_ms: float,
    ) -> None:
        self._coord = coord
        self._pools = list(pools)
        self._kind = kind
        self._owner = owner
        self._thread_id = thread_id
        self._released = False
        self._wait_ms = wait_ms

    @property
    def kind(self) -> ResourceKind:
        return self._kind

    @property
    def owner(self) -> str:
        return self._owner

    @property
    def wait_ms(self) -> float:
        return self._wait_ms

    def release(self) -> None:
        if self._released:
            return
        self._released = True
        self._coord._release_pools(self._pools, self._thread_id)

    def __enter__(self) -> "Permit":
        return self

    def __exit__(self, *exc) -> None:
        self.release()


class ResourceCoordinator:
    def __init__(self) -> None:
        self._pools: Dict[str, _Pool] = {}
        self._meta_lock = threading.Lock()
        # kind-level counters
        self._kind_acquires: Dict[str, int] = {k.value: 0 for k in ResourceKind}
        self._kind_wait_ms: Dict[str, float] = {k.value: 0.0 for k in ResourceKind}

    def _get_pool(self, name: str) -> _Pool:
        with self._meta_lock:
            pool = self._pools.get(name)
            if pool is None:
                pool = _Pool(name=name, limit=_pool_limit(name))
                self._pools[name] = pool
            return pool

    def acquire(
        self,
        kind: ResourceKind | Sequence[ResourceKind] = ResourceKind.GPU_MODEL,
        *,
        timeout: Optional[float] = None,
        cancel_event: Optional[threading.Event] = None,
        cancel_check: Optional[Callable[[], bool]] = None,
        owner: str = "",
    ) -> Permit:
        """Block until permits for all mapped pools are granted (FIFO per pool).

        ``timeout`` is total wall-clock seconds (None = wait forever).
        ``cancel_event`` / ``cancel_check`` if set remove this waiter without
        taking a permit (cancellation, HTTP disconnect, …).
        """
        kinds: List[ResourceKind]
        if isinstance(kind, ResourceKind):
            kinds = [kind]
        else:
            kinds = list(kind)
        if not kinds:
            raise ValueError("acquire requires at least one ResourceKind")

        # Primary kind for metrics = first requested.
        primary = kinds[0]
        # Unique pools in sorted order (stable multi-pool acquisition order).
        pool_names = sorted({_pool_for(k) for k in kinds})
        tid = threading.get_ident()
        owner = owner or f"thread-{tid}"
        t0 = time.monotonic()
        deadline = None if timeout is None else (t0 + max(0.0, timeout))

        acquired: List[str] = []
        try:
            for pname in pool_names:
                self._acquire_one(
                    pname,
                    primary,
                    owner=owner,
                    tid=tid,
                    deadline=deadline,
                    cancel_event=cancel_event,
                    cancel_check=cancel_check,
                )
                acquired.append(pname)
        except Exception:
            # Roll back any pools already taken in this multi-acquire.
            if acquired:
                self._release_pools(acquired, tid)
            raise

        wait_ms = (time.monotonic() - t0) * 1000.0
        with self._meta_lock:
            self._kind_acquires[primary.value] = self._kind_acquires.get(primary.value, 0) + 1
            self._kind_wait_ms[primary.value] = self._kind_wait_ms.get(primary.value, 0.0) + wait_ms
        return Permit(self, pool_names, primary, owner, tid, wait_ms)

    @staticmethod
    def _is_cancelled(
        cancel_event: Optional[threading.Event],
        cancel_check: Optional[Callable[[], bool]],
    ) -> bool:
        if cancel_event is not None and cancel_event.is_set():
            return True
        if cancel_check is not None:
            try:
                return bool(cancel_check())
            except Exception:  # noqa: BLE001 — treat check bugs as cancel (fail closed)
                log.exception("cancel_check raised during acquire; treating as cancelled")
                return True
        return False

    def _acquire_one(
        self,
        pool_name: str,
        kind: ResourceKind,
        *,
        owner: str,
        tid: int,
        deadline: Optional[float],
        cancel_event: Optional[threading.Event],
        cancel_check: Optional[Callable[[], bool]] = None,
    ) -> None:
        pool = self._get_pool(pool_name)
        with pool.condition:
            if tid in pool.holders:
                raise NestedAcquireError(
                    f"thread {tid} already holds pool '{pool_name}' "
                    f"(owner depth {pool.holders[tid]}). Nested acquire is forbidden — "
                    f"see resource_coordinator ownership boundary."
                )

            # Fast path: free slot and nobody waiting (preserve FIFO).
            if pool.active < pool.limit and not pool.waiters:
                # Still honour cancel so we never start work after user abort.
                if self._is_cancelled(cancel_event, cancel_check):
                    pool.total_cancels += 1
                    raise AcquireCancelledError(
                        f"acquire cancelled before grant for pool '{pool_name}'"
                    )
                pool.active += 1
                pool.holders[tid] = 1
                pool.total_acquires += 1
                return

            waiter = _Waiter(
                id=uuid.uuid4().hex,
                thread_id=tid,
                kind=kind,
                owner=owner,
                enqueued_at=time.monotonic(),
                cancel_event=cancel_event,
            )
            pool.waiters.append(waiter)

            # True once the granted permit has been handed to the caller (the
            # normal return). Any other exit while waiter.granted is set must
            # give the slot back or the pool leaks a permit forever.
            handed_over = False
            try:
                while True:
                    # Grant BEFORE cancel: _grant_waiters may have already
                    # committed this slot (active++/holders++) while cancel_event
                    # was being set in the same wake-up window. Raising cancelled
                    # here would leak that committed permit permanently (limit-1
                    # pool → every heavy job queues forever). Return the permit
                    # instead — every caller re-checks its own cancel flag right
                    # after acquire and releases via finally/context-manager.
                    if waiter.granted:
                        wait_ms = (time.monotonic() - waiter.enqueued_at) * 1000.0
                        pool.total_wait_ms += wait_ms
                        pool.total_acquires += 1
                        handed_over = True
                        return
                    if self._is_cancelled(cancel_event, cancel_check):
                        waiter.cancelled = True
                        self._drop_waiter(pool, waiter)
                        pool.total_cancels += 1
                        pool.condition.notify_all()
                        raise AcquireCancelledError(
                            f"acquire cancelled while waiting for pool '{pool_name}'"
                        )

                    remaining = None
                    if deadline is not None:
                        remaining = deadline - time.monotonic()
                        if remaining <= 0:
                            self._drop_waiter(pool, waiter)
                            pool.total_timeouts += 1
                            pool.condition.notify_all()
                            raise AcquireTimeoutError(
                                f"timed out waiting for pool '{pool_name}'"
                            )

                    # Wake periodically to re-check cancel_event / cancel_check.
                    poll = cancel_event is not None or cancel_check is not None
                    wait_for = 0.05 if poll else remaining
                    if remaining is not None and (wait_for is None or wait_for > remaining):
                        wait_for = remaining
                    pool.condition.wait(timeout=wait_for)
            finally:
                if waiter.granted and not handed_over:
                    # Exceptional exit after the grant committed (defensive: a
                    # raising cancel_check, interpreter shutdown, …) — undo it so
                    # the slot is never orphaned.
                    depth = pool.holders.get(tid, 0)
                    if depth <= 1:
                        pool.holders.pop(tid, None)
                    else:
                        pool.holders[tid] = depth - 1
                    pool.active = max(0, pool.active - 1)
                    self._grant_waiters(pool)
                elif not waiter.granted and waiter in pool.waiters:
                    # Left without a grant (cancel/timeout/exception) — make sure
                    # we are not left on the queue.
                    self._drop_waiter(pool, waiter)

    def _drop_waiter(self, pool: _Pool, waiter: _Waiter) -> None:
        try:
            pool.waiters.remove(waiter)
        except ValueError:
            pass

    def _grant_waiters(self, pool: _Pool) -> None:
        """FIFO: grant head waiters while capacity remains."""
        while pool.active < pool.limit and pool.waiters:
            w = pool.waiters[0]
            if w.cancelled:
                pool.waiters.popleft()
                continue
            pool.waiters.popleft()
            pool.active += 1
            pool.holders[w.thread_id] = pool.holders.get(w.thread_id, 0) + 1
            w.granted = True
            w.event.set()
            # Wake the specific waiter (and others waiting on condition).
            pool.condition.notify_all()

    def _release_pools(self, pool_names: Sequence[str], tid: int) -> None:
        for pname in reversed(list(pool_names)):
            pool = self._get_pool(pname)
            with pool.condition:
                depth = pool.holders.get(tid, 0)
                if depth <= 0:
                    log.warning("release pool '%s' by thread %s with no hold", pname, tid)
                    continue
                if depth == 1:
                    del pool.holders[tid]
                else:
                    pool.holders[tid] = depth - 1
                pool.active = max(0, pool.active - 1)
                self._grant_waiters(pool)

    def metrics(self) -> dict:
        """Snapshot for /metrics — never raises."""
        try:
            pools_out = {}
            with self._meta_lock:
                items = list(self._pools.items())
                kind_acq = dict(self._kind_acquires)
                kind_wait = dict(self._kind_wait_ms)
            # Ensure default pool appears even if never used.
            names = {n for n, _ in items} | {_DEFAULT_POOL}
            for name in sorted(names):
                pool = self._get_pool(name)
                with pool.condition:
                    waits = [
                        {
                            "id": w.id,
                            "owner": w.owner,
                            "kind": w.kind.value,
                            "waitMs": round((time.monotonic() - w.enqueued_at) * 1000.0, 1),
                        }
                        for w in pool.waiters
                        if not w.cancelled
                    ]
                    avg_wait = (
                        (pool.total_wait_ms / pool.total_acquires) if pool.total_acquires else 0.0
                    )
                    pools_out[name] = {
                        "limit": pool.limit,
                        "active": pool.active,
                        "free": max(0, pool.limit - pool.active),
                        "waiting": len(waits),
                        "waiters": waits,
                        "totalAcquires": pool.total_acquires,
                        "totalTimeouts": pool.total_timeouts,
                        "totalCancels": pool.total_cancels,
                        "totalWaitMs": round(pool.total_wait_ms, 1),
                        "avgWaitMs": round(avg_wait, 1),
                        "holders": len(pool.holders),
                    }
            return {
                "pools": pools_out,
                "kinds": {
                    k: {
                        "acquires": kind_acq.get(k, 0),
                        "totalWaitMs": round(kind_wait.get(k, 0.0), 1),
                    }
                    for k in (x.value for x in ResourceKind)
                },
                "kindToPool": {k.value: _pool_for(k) for k in ResourceKind},
            }
        except Exception as e:  # noqa: BLE001
            return {"error": str(e)[:200]}

    def pool_free(self, pool_name: str = _DEFAULT_POOL) -> int:
        pool = self._get_pool(pool_name)
        with pool.condition:
            return max(0, pool.limit - pool.active)

    def reset_for_tests(self) -> None:
        """Drop all pools (unit tests only)."""
        with self._meta_lock:
            self._pools.clear()
            self._kind_acquires = {k.value: 0 for k in ResourceKind}
            self._kind_wait_ms = {k.value: 0.0 for k in ResourceKind}


_COORDINATOR: Optional[ResourceCoordinator] = None
_COORD_LOCK = threading.Lock()


def get_coordinator() -> ResourceCoordinator:
    global _COORDINATOR
    with _COORD_LOCK:
        if _COORDINATOR is None:
            _COORDINATOR = ResourceCoordinator()
        return _COORDINATOR


def set_coordinator(coord: Optional[ResourceCoordinator]) -> None:
    """Tests inject a fresh coordinator."""
    global _COORDINATOR
    with _COORD_LOCK:
        _COORDINATOR = coord


@contextmanager
def resource_guard(
    kind: ResourceKind | Sequence[ResourceKind] = ResourceKind.GPU_MODEL,
    *,
    timeout: Optional[float] = None,
    cancel_event: Optional[threading.Event] = None,
    cancel_check: Optional[Callable[[], bool]] = None,
    owner: str = "",
) -> Iterator[Permit]:
    """Context manager: acquire → yield permit → always release."""
    permit = get_coordinator().acquire(
        kind,
        timeout=timeout,
        cancel_event=cancel_event,
        cancel_check=cancel_check,
        owner=owner,
    )
    try:
        yield permit
    finally:
        permit.release()


class SemaphoreFacade:
    """BoundedSemaphore-compatible façade over the shared ``heavy`` pool.

    Preserves monkeypatch points in tests (``HEAVY_JOB_SEMAPHORE = Fake()``) and
    the historic ``acquire(timeout=)`` / ``release()`` / ``_value`` API used by
    TTS / export / Demucs.
    """

    def __init__(self, kind: ResourceKind = ResourceKind.HEAVY_CPU) -> None:
        self._kind = kind
        self._local = threading.local()

    def _stack(self) -> List[Permit]:
        stack = getattr(self._local, "stack", None)
        if stack is None:
            stack = []
            self._local.stack = stack
        return stack

    def acquire(
        self,
        blocking: bool = True,
        timeout: Optional[float] = None,
        *,
        cancel_check: Callable[[], bool] | None = None,
    ) -> bool:
        if not blocking:
            timeout = 0.0 if timeout is None else timeout
        try:
            permit = get_coordinator().acquire(
                self._kind,
                timeout=timeout,
                cancel_check=cancel_check,
                owner=f"semaphore-facade:{self._kind.value}",
            )
        except AcquireTimeoutError:
            return False
        except AcquireCancelledError:
            return False
        except NestedAcquireError:
            # Same thread already holds the unified pool. A real BoundedSemaphore
            # would self-deadlock; with a timeout we fail closed (False) so call
            # sites that poll/retry keep working.
            if timeout is not None or not blocking:
                return False
            raise
        self._stack().append(permit)
        return True

    def release(self) -> None:
        stack = self._stack()
        if not stack:
            raise ValueError("Semaphore released too many times")
        stack.pop().release()

    @property
    def _value(self) -> int:
        """Diagnostics: free permits on the unified heavy pool."""
        return get_coordinator().pool_free(_pool_for(self._kind))


# Process-global façades — replace the old independent BoundedSemaphore(1).
# HEAVY_CPU: CPU-bound proxy / filter work (may split via XINCHAO_RESOURCE_SPLIT_CPU).
# GPU_MODEL: OmniVoice TTS must serialise with WhisperX even when
# CPU pool is split off.
HEAVY_JOB_SEMAPHORE = SemaphoreFacade(ResourceKind.HEAVY_CPU)
GPU_JOB_SEMAPHORE = SemaphoreFacade(ResourceKind.GPU_MODEL)
