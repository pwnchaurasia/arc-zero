"""The arcade's name depends on the address it was opened on (decision 2026-11-19)."""

from __future__ import annotations

from httpx import ASGITransport, AsyncClient

from arc_api.config import Settings
from arc_api.main import create_app


def test_brand_by_host() -> None:
    s = Settings(host_brands={"other.example.com": "Other Name"})
    assert s.brand_for("other.example.com") == "Other Name"
    assert s.brand_for("OTHER.example.com:443") == "Other Name"
    assert s.brand_for("play.example.com") == "Arc Zero"
    assert s.brand_for(None) == "Arc Zero"


async def test_manifest_and_me_carry_the_name_for_the_address(settings: Settings) -> None:
    host = "other.example.com"
    app = create_app(
        settings.model_copy(
            update={
                "host_brands": {host: "Other Name"},
                "allowed_hosts": [*settings.allowed_hosts, host],
            }
        )
    )
    async with app.router.lifespan_context(app):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url=f"http://{host}") as client:
            r = await client.get("/api/v1/manifest.webmanifest")
            assert r.status_code == 200
            assert r.headers["content-type"].startswith("application/manifest+json")
            assert r.json()["name"] == r.json()["short_name"] == "Other Name"
            assert "Arc Zero" not in r.text
            me = await client.get("/api/v1/me")
            assert me.json()["brand"] == "Other Name"
        async with AsyncClient(transport=transport, base_url="http://testserver") as client:
            r = await client.get("/api/v1/me")
            assert r.status_code == 200, (r.status_code, r.text[:200])
            assert r.json()["brand"] == "Arc Zero"
            r = await client.get("/api/v1/manifest.webmanifest")
            assert r.json()["name"] == "Arc Zero"
