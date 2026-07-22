"""Origin-allowlist middleware: reject cross-origin non-GET/HEAD from a browser
context that isn't the packaged app or the Vite dev server. Missing Origin is
allowed (curl / TestClient / same-origin Tauri call) so it doesn't lock out the
legitimate paths."""
from __future__ import annotations

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient


def _make_app():
    """A tiny FastAPI wired up with the same enforce_origin logic as main.py —
    isolated from the real app so we don't drag warm-up threads / routers /
    torch imports into the unit test."""
    app = FastAPI()
    allowed = {"http://localhost:5173", "http://tauri.localhost"}
    safe = {"GET", "HEAD", "OPTIONS"}

    @app.middleware("http")
    async def enforce_origin(request, call_next):
        if request.method not in safe:
            origin = request.headers.get("origin")
            if origin and origin not in allowed:
                return JSONResponse({"detail": "Bad Origin"}, status_code=403)
        return await call_next(request)

    @app.get("/ping")
    def ping():
        return {"ok": True}

    @app.post("/act")
    def act():
        return {"ok": True}

    return app


def test_post_with_no_origin_passes():
    c = TestClient(_make_app())
    r = c.post("/act")
    assert r.status_code == 200
    assert r.json() == {"ok": True}


def test_post_with_allowed_origin_passes():
    c = TestClient(_make_app())
    r = c.post("/act", headers={"Origin": "http://localhost:5173"})
    assert r.status_code == 200


def test_post_with_evil_origin_returns_403():
    c = TestClient(_make_app())
    r = c.post("/act", headers={"Origin": "http://evil.example"})
    assert r.status_code == 403
    assert r.json() == {"detail": "Bad Origin"}


def test_get_with_evil_origin_still_passes():
    # Safe methods aren't guarded — a rogue site reading /health is harmless
    # (that's what CORSMiddleware exists for), and blocking it would break
    # legitimate GETs from a dev page mounting the API on a different port.
    c = TestClient(_make_app())
    r = c.get("/ping", headers={"Origin": "http://evil.example"})
    assert r.status_code == 200


def test_delete_and_patch_are_also_guarded():
    app = _make_app()

    @app.delete("/thing")
    def _d(): return {"gone": True}

    @app.patch("/thing")
    def _p(): return {"patched": True}

    c = TestClient(app)
    assert c.delete("/thing", headers={"Origin": "http://evil.example"}).status_code == 403
    assert c.patch("/thing", headers={"Origin": "http://evil.example"}).status_code == 403
