"""Content hashes are used as `glob.glob(f"{hash}.*")` patterns to locate a
stored asset. A hash containing shell wildcards would match another user's file
— and worse, a hash containing a path separator once tricked us into globbing
outside the assets dir. Both surfaces are hex-only now."""
from __future__ import annotations

import asyncio
import hashlib
import io
import os

import pytest

from app.routers import assets


@pytest.fixture(autouse=True)
def scratch_store(tmp_path, monkeypatch):
    """Redirect the assets dir so tests never touch the real store."""
    monkeypatch.setattr(assets, "_assets_dir", lambda: str(tmp_path))
    return tmp_path


def test_asset_path_rejects_star_wildcard():
    assert assets.asset_path("*") is None
    assert assets.asset_path("*.mp4") is None


def test_asset_path_rejects_path_separators():
    assert assets.asset_path("../etc/passwd") is None
    assert assets.asset_path("a/b") is None
    assert assets.asset_path("a\\b") is None


def test_asset_path_rejects_short_or_non_hex():
    assert assets.asset_path("") is None
    assert assets.asset_path("abc") is None            # too short
    assert assets.asset_path("g" * 32) is None         # 'g' not hex
    assert assets.asset_path("HELLO" * 8) is None      # non-hex letters


def test_asset_path_accepts_valid_hex_but_returns_none_when_missing(scratch_store):
    # Hash is well-formed but nothing is stored under it → None (not an error).
    assert assets.asset_path("a" * 64) is None


def test_asset_path_finds_stored_hex(scratch_store):
    # Drop a file that matches the hex pattern and confirm we resolve it.
    p = scratch_store / f"{'a' * 64}.bin"
    p.write_bytes(b"x")
    assert assets.asset_path("a" * 64) == str(p)


def test_asset_info_returns_zero_copy_desktop_path(scratch_store):
    p = scratch_store / f"{'b' * 64}.mp4"
    p.write_bytes(b"video-bytes")

    info = assets.assets_info("b" * 64)

    assert info == {
        "path": os.path.abspath(p),
        "name": p.name,
        "sizeBytes": len(b"video-bytes"),
    }


class _FakeUploadFile:
    """Minimal shim mirroring what FastAPI's UploadFile exposes to the route:
    an async .read() the route doesn't use, and a `.file` with sync .read()."""
    def __init__(self, data: bytes, filename: str = "u.bin"):
        self.filename = filename
        self.size = len(data)
        self.file = io.BytesIO(data)


class _FakeRequest:
    def __init__(self, content_length: str | None = None):
        self.headers = {}
        if content_length is not None:
            self.headers["content-length"] = content_length


class _FakeAdoptRequest:
    def __init__(self, disconnected: bool = False):
        self.disconnected = disconnected

    async def is_disconnected(self) -> bool:
        return self.disconnected


def test_adopt_path_streams_to_compatible_hash(scratch_store, monkeypatch, tmp_path):
    data = (b"local-path-media" * 4096) + b"tail"
    source = tmp_path / "source.mp4"
    source.write_bytes(data)
    events: list[tuple[str, int]] = []
    monkeypatch.setattr(
        assets,
        "reserve_external_output",
        lambda reservation_id, estimated, *_a, **_k: events.append((reservation_id, estimated)),
    )
    monkeypatch.setattr(
        assets,
        "release_external_output",
        lambda reservation_id: events.append((reservation_id, -1)),
    )

    result = asyncio.run(assets.assets_adopt_path(
        assets.AdoptPathBody(sourcePath=str(source), filename="source.mp4"),
        _FakeAdoptRequest(),
    ))

    expected = hashlib.sha256(data).hexdigest()
    assert result["hash"] == expected
    assert (scratch_store / f"{expected}.mp4").read_bytes() == data
    assert not list(scratch_store.glob(".adopt-*"))
    assert events[-1] == (events[0][0], -1)


def test_adopt_path_cancellation_removes_scratch(scratch_store, monkeypatch, tmp_path):
    source = tmp_path / "cancel.mp4"
    source.write_bytes(b"x" * 1024)
    monkeypatch.setattr(assets, "reserve_external_output", lambda *_a, **_k: None)
    released: list[str] = []
    monkeypatch.setattr(assets, "release_external_output", released.append)

    with pytest.raises(Exception) as exc:
        asyncio.run(assets.assets_adopt_path(
            assets.AdoptPathBody(sourcePath=str(source), filename="cancel.mp4"),
            _FakeAdoptRequest(disconnected=True),
        ))

    assert getattr(exc.value, "status_code", None) == 499
    assert not list(scratch_store.glob(".adopt-*"))
    assert len(released) == 1


def test_upload_rejects_bad_hash(scratch_store):
    with pytest.raises(Exception) as exc:
        assets.assets_upload(request=_FakeRequest(), file=_FakeUploadFile(b"x"), hash="*")
    assert getattr(exc.value, "status_code", None) == 400


def test_upload_413_when_over_cap(scratch_store, monkeypatch):
    """A 2 KiB payload with a 1 KiB cap → 413, and neither the final dest nor
    the .tmp scratch is left behind (follow-up uploads must not short-circuit
    to a partial file via asset_path)."""
    from app import config as app_config

    # Shrink the cap for this test only. `get_settings` is @lru_cache-d, so
    # substituting the accessor is more reliable than mutating the cached obj.
    real = app_config.get_settings()
    fake = type(real)(**{**real.model_dump(), "upload_max_bytes": 1024})
    monkeypatch.setattr(app_config, "get_settings", lambda: fake)
    monkeypatch.setattr(assets, "get_settings", lambda: fake)

    hex64 = "a" * 64
    with pytest.raises(Exception) as exc:
        assets.assets_upload(
            request=_FakeRequest(),
            file=_FakeUploadFile(b"x" * 2048),
            hash=hex64,
        )
    assert getattr(exc.value, "status_code", None) == 413
    assert assets.asset_path(hex64) is None
    # No .tmp scratch either — otherwise disk-quota accounting drifts.
    assert not list(scratch_store.glob(f"{hex64}*"))


def test_upload_413_when_over_assets_quota_even_if_upload_max_higher(scratch_store, monkeypatch):
    """#13: upload_max 10GB-style but assets_quota 1 KiB → single file > quota fails
    clearly; file is NOT stored then deleted by cleanup."""
    from app import config as app_config

    real = app_config.get_settings()
    fake = type(real)(
        **{
            **real.model_dump(),
            "upload_max_bytes": 10 * 1024**3,
            "assets_quota_mb": 0,  # set via monkeypatch after — use bytes path
        }
    )
    # 1 MiB quota, 2 MiB upload max → effective cap 1 MiB
    object.__setattr__(fake, "assets_quota_mb", 1)  # 1 MB
    object.__setattr__(fake, "upload_max_bytes", 10 * 1024 * 1024)
    monkeypatch.setattr(app_config, "get_settings", lambda: fake)
    monkeypatch.setattr(assets, "get_settings", lambda: fake)

    hex64 = "d" * 64
    with pytest.raises(Exception) as exc:
        assets.assets_upload(
            request=_FakeRequest(),
            file=_FakeUploadFile(b"x" * (2 * 1024 * 1024)),
            hash=hex64,
        )
    assert getattr(exc.value, "status_code", None) == 413
    assert assets.asset_path(hex64) is None


def test_just_uploaded_asset_survives_cleanup_under_quota_pressure(scratch_store, monkeypatch):
    """Grace + lease: new upload is not LRU-deleted by the post-upload cleanup."""
    from app import config as app_config
    from app.export import integrity as integ

    integ.reset_leases_for_tests()
    real = app_config.get_settings()
    fake = type(real)(**{**real.model_dump(), "upload_max_bytes": 10 * 1024 * 1024})
    object.__setattr__(fake, "assets_quota_mb", 1)  # 1 MB total
    object.__setattr__(fake, "assets_ttl_days", 0)
    object.__setattr__(fake, "upload_max_bytes", 5 * 1024 * 1024)
    monkeypatch.setattr(app_config, "get_settings", lambda: fake)
    monkeypatch.setattr(assets, "get_settings", lambda: fake)

    # Fill store with an old large file so quota is tight.
    old = scratch_store / f"{'e' * 64}.bin"
    old.write_bytes(b"o" * (900 * 1024))
    os.utime(old, (1, 1))

    payload = b"n" * (200 * 1024)
    hex64 = hashlib.sha256(payload).hexdigest()
    # 200 KiB fits under upload cap; total may exceed 1MB quota with old file.
    resp = assets.assets_upload(
        request=_FakeRequest(),
        file=_FakeUploadFile(payload),
        hash=hex64,
    )
    assert resp["assetId"] == hex64
    assert assets.asset_path(hex64) is not None, "just-uploaded asset must not be cleaned away"


def test_upload_rejects_content_hash_mismatch_without_publish(scratch_store):
    payload = b"actual media bytes"
    wrong_hash = hashlib.sha256(b"different bytes").hexdigest()

    with pytest.raises(Exception) as exc:
        assets.assets_upload(
            request=_FakeRequest(),
            file=_FakeUploadFile(payload),
            hash=wrong_hash,
        )

    assert getattr(exc.value, "status_code", None) == 422
    assert assets.asset_path(wrong_hash) is None
    assert not list(scratch_store.glob(".upload-*"))


def test_upload_verifies_large_two_level_hash(scratch_store, monkeypatch):
    # Exercise the frontend's >64 MiB branch without allocating a huge fixture.
    monkeypatch.setattr(assets, "_CONTENT_HASH_CHUNK", 8)
    payload = b"01234567abcdefghXYZ"
    digests = [
        hashlib.sha256(payload[i:i + 8]).digest()
        for i in range(0, len(payload), 8)
    ]
    expected = hashlib.sha256(b"".join(digests)).hexdigest()

    result = assets.assets_upload(
        request=_FakeRequest(),
        file=_FakeUploadFile(payload),
        hash=expected,
    )

    assert result["assetId"] == expected
    stored = assets.asset_path(expected)
    assert stored is not None
    with open(stored, "rb") as uploaded:
        assert uploaded.read() == payload


class _ExplodingUploadFile:
    """A read() that fails mid-stream, mimicking disk-full / AV lock / SIGKILL
    that isn't the 413 branch — must still leave nothing at the final dest."""
    def __init__(self, filename: str = "u.bin"):
        self.filename = filename
        self.size = 1024
        self._calls = 0

        class _F:
            def read(inner, n):  # noqa: N805
                self._calls += 1
                if self._calls == 1:
                    return b"x" * 512  # a real chunk lands on disk first
                raise OSError("simulated I/O failure")
        self.file = _F()


def test_upload_leaves_no_dest_on_io_error(scratch_store):
    """A non-413 write failure (OSError from the underlying stream) must not
    leave a half-written file at dest — asset_path would otherwise treat it as
    valid and later exports would consume corrupted media."""
    hex64 = "b" * 64
    with pytest.raises(OSError):
        assets.assets_upload(
            request=_FakeRequest(),
            file=_ExplodingUploadFile(),
            hash=hex64,
        )
    # Final dest doesn't exist AND no scratch is left behind.
    assert assets.asset_path(hex64) is None
    assert not list(scratch_store.glob(f"{hex64}*"))
    assert not list(scratch_store.glob(".upload-*"))


def test_orphan_scratch_never_matches_asset_path(scratch_store):
    """Regression: an abandoned upload scratch that happens to sit next to the
    assets dir must NOT be resolved as a valid asset by asset_path()'s
    `<hash>.*` glob. Historically the scratch was named `<hash>.mp4.tmp` and
    got picked up after a crash — now it lives at `.upload-<uuid>.tmp` outside
    the glob pattern."""
    hex64 = "c" * 64
    # Simulate crash-left detritus in both the old-shape and the new-shape.
    (scratch_store / ".upload-deadbeef.tmp").write_bytes(b"orphan")
    (scratch_store / f"{hex64}.mp4.tmp").write_bytes(b"legacy-orphan")
    # Neither should resolve — the hash has no clean asset on disk.
    assert assets.asset_path(hex64) is None


def test_upload_reserves_free_disk_and_releases_on_failure(scratch_store, monkeypatch):
    events: list[tuple[str, int]] = []
    monkeypatch.setattr(
        assets,
        "reserve_external_output",
        lambda reservation_id, estimated, *_a, **_k: events.append((reservation_id, estimated)),
    )
    monkeypatch.setattr(
        assets,
        "release_external_output",
        lambda reservation_id: events.append((reservation_id, -1)),
    )
    with pytest.raises(OSError):
        assets.assets_upload(
            request=_FakeRequest(),
            file=_ExplodingUploadFile(),
            hash="9" * 64,
        )
    assert events[0][0].startswith("asset-upload-")
    assert events[0][1] >= 128 * 1024 * 1024
    assert events[-1] == (events[0][0], -1)
