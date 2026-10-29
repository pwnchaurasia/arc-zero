"""Production must refuse unsafe settings, including an unencrypted database."""

from __future__ import annotations

from typing import Any

import pytest
from pydantic import ValidationError

from arc_api.config import Settings

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
    ],
)
def test_unsafe_production_settings_rejected(field: str, value: Any) -> None:
    with pytest.raises(ValidationError):
        Settings(**{**SAFE, field: value})
