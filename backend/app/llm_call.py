"""Shared LLM transport helpers: split timeouts, cancel polling, retry.

Used by the caption translate router. SDKs that cannot cancel mid-request run in a
worker thread while we poll ``cancel_check`` and close the underlying HTTP
client (httpx) or abandon the result after process-level terminate for
truly uncancelable SDKs.
"""
from __future__ import annotations

import logging
import queue
import random
import threading
import time
from concurrent.futures import TimeoutError as FuturesTimeout
from typing import Any, Callable, TypeVar

import httpx

logger = logging.getLogger(__name__)

T = TypeVar("T")

# Split timeouts (seconds). Read dominates — long vision / script prompts.
CONNECT_TIMEOUT_SEC = 10.0
READ_TIMEOUT_SEC = 180.0
WRITE_TIMEOUT_SEC = 60.0
POOL_TIMEOUT_SEC = 10.0
# Wall-clock ceiling for one attempt (connect + write + read + margin).
TOTAL_TIMEOUT_SEC = CONNECT_TIMEOUT_SEC + WRITE_TIMEOUT_SEC + READ_TIMEOUT_SEC + 15.0

DEFAULT_MAX_ATTEMPTS = 3
DEFAULT_BASE_DELAY_SEC = 0.5
DEFAULT_MAX_DELAY_SEC = 20.0

CancelCheck = Callable[[], bool]


class LlmCancelled(Exception):
    """Raised when cancel_check fires during an LLM call."""


class LlmTimeout(Exception):
    """Raised when a single attempt exceeds the configured timeout."""


class LlmWorkerStuck(Exception):
    """An SDK call ignored cancellation; do not start a retry beside it."""


class LlmRemoteError(Exception):
    """Serializable error reconstructed from a killable SDK child process."""

    def __init__(
        self,
        message: str,
        *,
        remote_type: str,
        retryable: bool,
        status_code: int | None = None,
    ) -> None:
        super().__init__(f"{remote_type}: {message}")
        self.remote_type = remote_type
        self.retryable = retryable
        self.status_code = status_code


def message_text(content: object) -> str:
    """Join OpenAI-compatible string or multipart message content safely."""
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    parts: list[str] = []
    for part in content:
        if isinstance(part, str):
            parts.append(part)
        elif isinstance(part, dict):
            text = part.get("text")
            if isinstance(text, str):
                parts.append(text)
    return "".join(parts)


# Ceiling on simultaneously-running provider calls. It exists to stop an
# unbounded pileup of abandoned stuck worker threads (each holds its slot until
# the provider call actually returns), NOT to throttle legitimate concurrency —
# translation fans batches out ~6 wide while TTS may call in parallel,
# so the cap must sit comfortably above normal fan-out.
_SDK_THREAD_SLOTS = threading.BoundedSemaphore(16)
# How long a caller may wait for a slot before concluding the pool is wedged by
# stuck calls. Waiting (with cancel polling) beats the old instant failure,
# which made concurrent-but-healthy callers error out spuriously.
_SDK_SLOT_WAIT_SEC = 30.0


def httpx_timeout(
    *,
    connect: float = CONNECT_TIMEOUT_SEC,
    read: float = READ_TIMEOUT_SEC,
    write: float = WRITE_TIMEOUT_SEC,
    pool: float = POOL_TIMEOUT_SEC,
) -> httpx.Timeout:
    """httpx Timeout with explicit connect/read/write/pool (no single float)."""
    return httpx.Timeout(connect=connect, read=read, write=write, pool=pool)


def is_retryable_http_status(status: int) -> bool:
    return status == 429 or status >= 500


def is_retryable_exc(exc: BaseException) -> bool:
    """Timeout / 429 / 5xx — not auth, not 4xx client errors."""
    if isinstance(exc, LlmRemoteError):
        return exc.retryable
    if isinstance(exc, (LlmTimeout, TimeoutError, FuturesTimeout)):
        return True
    if isinstance(exc, LlmWorkerStuck):
        return False
    if isinstance(exc, httpx.TimeoutException):
        return True
    if isinstance(exc, httpx.HTTPStatusError):
        return is_retryable_http_status(exc.response.status_code)
    # Anthropic SDK
    name = type(exc).__name__
    mod = type(exc).__module__ or ""
    if "Timeout" in name or name in ("APITimeoutError", "APIConnectionError"):
        return True
    if name == "RateLimitError":
        return True
    if name == "InternalServerError":
        return True
    status = getattr(exc, "status_code", None)
    if isinstance(status, int) and is_retryable_http_status(status):
        return True
    # google.api_core / genai often wrap as RetryError or ServiceUnavailable
    if "ServiceUnavailable" in name or "TooManyRequests" in name or "ResourceExhausted" in name:
        return True
    msg = str(exc).lower()
    if "timed out" in msg or "timeout" in msg or "429" in msg:
        return True
    if " 500" in msg or " 502" in msg or " 503" in msg or " 504" in msg:
        return True
    # Avoid treating cancel as retryable
    if isinstance(exc, LlmCancelled):
        return False
    del mod  # reserved for future module-specific filters
    return False


def is_retryable_provider_rejection(exc: BaseException) -> bool:
    """Retry only an explicit provider-side 429/5xx rejection.

    Generation read/write/wall timeouts and connection drops are ambiguous: the
    provider may already be processing or billing the request. Retrying those
    can turn one 3-4 minute timeout into a 12+ minute stuck stage and can
    purchase duplicate generations. SDKs expose explicit rate/server failures
    through status codes or well-known exception types; those remain retryable.
    """
    if isinstance(
        exc,
        (
            LlmTimeout,
            LlmWorkerStuck,
            TimeoutError,
            FuturesTimeout,
            httpx.TimeoutException,
        ),
    ):
        return False
    if isinstance(exc, httpx.HTTPStatusError):
        return is_retryable_http_status(exc.response.status_code)
    if isinstance(exc, LlmRemoteError):
        if isinstance(exc.status_code, int):
            return is_retryable_http_status(exc.status_code)
        remote_name = exc.remote_type.lower()
        if "timeout" in remote_name or "connection" in remote_name:
            return False
        return any(
            token in remote_name
            for token in (
                "ratelimit",
                "toomanyrequests",
                "resourceexhausted",
                "internalserver",
                "serviceunavailable",
            )
        )

    status = getattr(exc, "status_code", None)
    if isinstance(status, int):
        return is_retryable_http_status(status)
    name = type(exc).__name__.lower()
    if "timeout" in name or "connection" in name:
        return False
    return any(
        token in name
        for token in (
            "ratelimit",
            "toomanyrequests",
            "resourceexhausted",
            "internalserver",
            "serviceunavailable",
        )
    )


def _sleep_cancellable(seconds: float, cancel_check: CancelCheck | None) -> None:
    if seconds <= 0:
        return
    deadline = time.monotonic() + seconds
    while True:
        if cancel_check and cancel_check():
            raise LlmCancelled("cancelled during retry backoff")
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return
        time.sleep(min(0.2, remaining))


def backoff_delay(attempt: int, *, base: float = DEFAULT_BASE_DELAY_SEC,
                  cap: float = DEFAULT_MAX_DELAY_SEC) -> float:
    """Exponential backoff with full jitter. ``attempt`` is 0-based."""
    exp = min(cap, base * (2 ** attempt))
    return random.uniform(0.0, exp)


def call_with_retry(
    fn: Callable[[], T],
    *,
    cancel_check: CancelCheck | None = None,
    max_attempts: int = DEFAULT_MAX_ATTEMPTS,
    base_delay: float = DEFAULT_BASE_DELAY_SEC,
    is_retryable: Callable[[BaseException], bool] = is_retryable_exc,
    label: str = "llm",
) -> T:
    """Invoke ``fn`` with cancel pre-check and retry on timeout/429/5xx."""
    last: BaseException | None = None
    attempts = max(1, max_attempts)
    for attempt in range(attempts):
        if cancel_check and cancel_check():
            raise LlmCancelled(f"{label}: cancelled before attempt {attempt + 1}")
        try:
            return fn()
        except LlmCancelled:
            raise
        except Exception as exc:  # noqa: BLE001 — classified below
            last = exc
            if attempt + 1 >= attempts or not is_retryable(exc):
                raise
            delay = backoff_delay(attempt, base=base_delay)
            logger.warning(
                "%s attempt %d/%d failed (%s); retry in %.2fs",
                label, attempt + 1, attempts, type(exc).__name__, delay,
            )
            _sleep_cancellable(delay, cancel_check)
    assert last is not None
    raise last


def run_cancellable(
    fn: Callable[[], T],
    *,
    cancel_check: CancelCheck | None = None,
    timeout_sec: float = TOTAL_TIMEOUT_SEC,
    on_cancel: Callable[[], None] | None = None,
    label: str = "llm",
) -> T:
    """Run ``fn`` in a worker thread; poll cancel and enforce wall timeout.

    When ``cancel_check`` fires or the wall clock expires, ``on_cancel`` is
    invoked (e.g. close httpx client) so the blocked socket unblocks. The
    worker thread is abandoned after cancel (daemon pool).
    """
    if cancel_check and cancel_check():
        raise LlmCancelled(f"{label}: cancelled before start")

    # No cancel path and no need to interrupt — run inline (cheaper).
    if cancel_check is None and timeout_sec <= 0:
        return fn()

    slot_deadline = time.monotonic() + _SDK_SLOT_WAIT_SEC
    while not _SDK_THREAD_SLOTS.acquire(timeout=0.2):
        if cancel_check and cancel_check():
            raise LlmCancelled(f"{label}: cancelled while waiting for an SDK worker slot")
        if time.monotonic() >= slot_deadline:
            raise LlmWorkerStuck(f"{label}: all SDK worker slots are occupied")
    result: queue.Queue[tuple[str, object]] = queue.Queue(maxsize=1)

    def worker() -> None:
        try:
            result.put(("ok", fn()))
        except BaseException as exc:  # noqa: BLE001
            result.put(("err", exc))
        finally:
            _SDK_THREAD_SLOTS.release()

    # Explicit daemon thread: unlike ThreadPoolExecutor workers it cannot keep
    # backend/app shutdown alive when a third-party SDK ignores socket close.
    thread = threading.Thread(target=worker, name=f"{label}-call", daemon=True)
    thread.start()
    deadline = time.monotonic() + max(0.1, timeout_sec)
    while True:
        if cancel_check and cancel_check():
            if on_cancel:
                try:
                    on_cancel()
                except Exception:  # noqa: BLE001
                    logger.exception("%s on_cancel failed", label)
            raise LlmCancelled(f"{label}: cancelled")
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            if on_cancel:
                try:
                    on_cancel()
                except Exception:  # noqa: BLE001
                    logger.exception("%s on_cancel (timeout) failed", label)
            thread.join(timeout=2.0)
            if thread.is_alive():
                raise LlmWorkerStuck(
                    f"{label}: provider call ignored cancellation after {timeout_sec:.0f}s"
                )
            raise LlmTimeout(f"{label}: timed out after {timeout_sec:.0f}s")
        try:
            kind, payload = result.get(timeout=min(0.2, remaining))
        except queue.Empty:
            continue
        if kind == "ok":
            return payload  # type: ignore[return-value]
        assert isinstance(payload, BaseException)
        raise payload


def _mp_worker(queue: Any, fn: Callable[..., Any], args: tuple, kwargs: dict) -> None:
    """Top-level target so Windows spawn can pickle the child entrypoint."""
    try:
        queue.put(("ok", fn(*args, **kwargs)))
    except Exception as exc:  # noqa: BLE001 — re-raise in parent
        # SDK errors often retain sockets/locks and cannot be pickled. Sending
        # the original exception lets Queue.put return, then its feeder thread
        # fails silently and the parent sees "no result". Primitive metadata is
        # deterministic and preserves the retry decision.
        try:
            message = str(exc)
        except Exception:  # noqa: BLE001
            message = "remote provider error"
        status = getattr(exc, "status_code", None)
        queue.put((
            "remote_err",
            {
                "message": message[:4000],
                "remote_type": type(exc).__name__,
                "retryable": is_retryable_exc(exc),
                "status_code": status if isinstance(status, int) else None,
            },
        ))


def _unwrap_process_message(kind: str, payload: object) -> T:
    if kind == "ok":
        return payload  # type: ignore[return-value]
    if kind == "remote_err" and isinstance(payload, dict):
        status = payload.get("status_code")
        raise LlmRemoteError(
            str(payload.get("message") or "remote provider error"),
            remote_type=str(payload.get("remote_type") or "RemoteError"),
            retryable=bool(payload.get("retryable")),
            status_code=status if isinstance(status, int) else None,
        )
    if isinstance(payload, BaseException):
        raise payload
    raise RuntimeError("llm child returned an invalid error payload")


def run_in_process(
    fn: Callable[..., T],
    args: tuple = (),
    kwargs: dict | None = None,
    *,
    cancel_check: CancelCheck | None = None,
    timeout_sec: float = TOTAL_TIMEOUT_SEC,
    label: str = "llm",
) -> T:
    """Run a picklable ``fn(*args, **kwargs)`` in a killable child process.

    For SDKs that hold the GIL / ignore closed sockets. ``fn`` must be a
    top-level (module) function so Windows spawn can pickle it. Prefer
    :func:`run_cancellable` with httpx close when possible (lighter).
    """
    import multiprocessing as mp

    if cancel_check and cancel_check():
        raise LlmCancelled(f"{label}: cancelled before start")

    kw = kwargs or {}
    ctx = mp.get_context("spawn")
    q: mp.Queue = ctx.Queue(1)
    proc = ctx.Process(
        target=_mp_worker,
        args=(q, fn, args, kw),
        name=f"{label}-proc",
        daemon=True,
    )
    proc.start()
    deadline = time.monotonic() + max(0.1, timeout_sec)
    try:
        message: tuple[str, object] | None = None
        while True:
            if cancel_check and cancel_check():
                _terminate_proc(proc)
                raise LlmCancelled(f"{label}: cancelled")
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                _terminate_proc(proc)
                raise LlmTimeout(f"{label}: timed out after {timeout_sec:.0f}s")
            # Drain while the child is alive. Waiting for process exit before
            # reading can deadlock once a large JSON response fills the Queue's
            # OS pipe: the child waits for its feeder, while the parent waits
            # for the child. Queue.empty() is also explicitly unreliable.
            try:
                message = q.get(timeout=min(0.1, remaining))
            except queue.Empty:
                message = None
            if message is not None:
                kind, payload = message
                proc.join(timeout=1.0)
                return _unwrap_process_message(kind, payload)
            if not proc.is_alive():
                break
            proc.join(timeout=min(0.1, remaining))

        # The process can exit a few milliseconds before its Queue feeder makes
        # the final message visible. Give that hand-off a short bounded wait.
        try:
            kind, payload = q.get(timeout=0.5)
        except queue.Empty:
            kind = ""
            payload = None
        if kind:
            return _unwrap_process_message(kind, payload)
        if proc.exitcode not in (0, None):
            raise RuntimeError(f"{label}: child exited {proc.exitcode}")
        raise RuntimeError(f"{label}: child returned no result")
    finally:
        if proc.is_alive():
            _terminate_proc(proc)
        try:
            q.close()
        except Exception:  # noqa: BLE001
            pass


def _terminate_proc(proc: Any) -> None:
    try:
        proc.terminate()
        proc.join(timeout=2)
    except Exception:  # noqa: BLE001
        pass
    if proc.is_alive():
        try:
            proc.kill()
        except Exception:  # noqa: BLE001
            pass
        try:
            proc.join(timeout=1)
        except Exception:  # noqa: BLE001
            pass
