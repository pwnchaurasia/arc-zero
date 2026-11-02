"""Production must refuse unsafe settings, including an unencrypted database."""

from __future__ import annotations

from typing import Any

import pytest
from httpx import ASGITransport, AsyncClient
from pydantic import ValidationError

from arc_api.config import Settings
from arc_api.main import create_app

SAFE: dict[str, Any] = {
    "env": "production",
    "database_url": "postgresql+asyncpg://arc:pw@db.example.com:5432/arc?ssl=require",
    "signing_keys": {"k1": "k" * 40},
    "signing_kid": "k1",
    "recovery_pepper": "p" * 40,
    "allowed_origins": ["https://play.example.com"],
    "allowed_hosts": ["play.example.com"],
    "cookie_secure": True,
    "hsts": True,
    "expose_docs": False,
}


def test_safe_production_settings_load() -> None:
    assert Settings(**SAFE).cookie_name == "__Host-arc_session"


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("database_url", "postgresql+asyncpg://arc:pw@db.example.com:5432/arc"),
        ("database_url", "postgresql+asyncpg://arc:pw@db.example.com:5432/arc?ssl=disable"),
        ("cookie_secure", False),
        ("hsts", False),
        ("expose_docs", True),
        ("allowed_origins", ["http://play.example.com"]),
        ("recovery_pepper", "short"),
        ("dev_unlock_all", True),
        ("dev_tunnel", True),
    ],
)
def test_unsafe_production_settings_rejected(field: str, value: Any) -> None:
    with pytest.raises(ValidationError):
        Settings(**{**SAFE, field: value})


async def test_tunnel_mode_lets_ngrok_in_only_when_switched_on(
    app_client: AsyncClient, settings: Settings
) -> None:
    ngrok = "https://253e-2405-201.ngrok-free.app"
    headers = {"origin": ngrok, "host": "253e-2405-201.ngrok-free.app"}
    # Off (the default): an ngrok page is a stranger.
    r = await app_client.post("/api/v1/games/water-sort/levels/1/start", headers=headers)
    assert r.status_code in (400, 403)

    tunnel = create_app(settings.model_copy(update={"dev_tunnel": True}))
    async with tunnel.router.lifespan_context(tunnel):
        transport = ASGITransport(app=tunnel)
        async with AsyncClient(transport=transport, base_url=ngrok) as client:
            r = await client.post("/api/v1/games/water-sort/levels/1/start", headers=headers)
            assert r.status_code == 200, r.text
            # Look-alikes are still blocked.
            for bad in (
                "https://ngrok-free.app.evil.com",
                "http://x.ngrok-free.app",
                "https://evil.com",
            ):
                r = await client.post(
                    "/api/v1/games/water-sort/levels/1/start", headers={**headers, "origin": bad}
                )
                assert r.status_code == 403, bad
