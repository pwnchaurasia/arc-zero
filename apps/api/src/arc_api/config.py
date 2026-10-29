"""Runtime configuration, read from `ARC_*` environment variables.

Production refuses to start with unsafe settings (see `Settings.check_production`).
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import Field, SecretStr, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

MIN_SECRET_LEN = 32


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="ARC_", env_file=".env", extra="ignore")

    env: Literal["development", "test", "production"] = "development"
    log_level: str = "INFO"

    database_url: SecretStr = SecretStr("postgresql+asyncpg://arc:arc@localhost:5432/arc")
    redis_url: SecretStr = SecretStr("redis://localhost:6379/0")
    levels_path: Path = Path("levels.json")

    # HMAC keys for signed tokens (guest tickets, PoW challenges), by key id.
    # Rotate by adding a new key, switching `signing_kid`, and removing the old
    # key once every outstanding token has expired.
    signing_keys: dict[str, SecretStr] = Field(default_factory=dict)
    signing_kid: str = "k1"
    # Pepper for recovery-key hashes. Changing it invalidates every account key.
    recovery_pepper: SecretStr = SecretStr("")

    allowed_origins: list[str] = ["http://localhost:5173"]
    allowed_hosts: list[str] = ["localhost", "127.0.0.1", "testserver"]
    expose_docs: bool = False
    hsts: bool = False

    cookie_secure: bool = False
    session_ttl_days: int = Field(default=30, ge=1, le=365)

    pow_difficulty: int = Field(default=18, ge=8, le=28)
    pow_surge_difficulty: int = Field(default=21, ge=8, le=30)
    pow_surge_per_minute: int = Field(default=30, ge=1)
    pow_ttl_seconds: int = Field(default=300, ge=30)

    guest_max_level: int = Field(default=3, ge=1)
    guest_ticket_ttl_days: int = Field(default=7, ge=1)
    hints_per_day: int = Field(default=3, ge=0)

    # Engine calls run in worker threads; bound them so CPU can't be exhausted.
    engine_threads: int = Field(default=4, ge=1)
    ws_min_ms_per_move: int = Field(default=150, ge=0)
    bb_min_ms_between_turns: int = Field(default=250, ge=0)
    ws_hint_budget: int = Field(default=80_000, ge=1_000)
    bb_hint_candidates: int = Field(default=41, ge=5, le=161)

    @property
    def cookie_name(self) -> str:
        # The __Host- prefix forces Secure, Path=/ and no Domain in the browser.
        return "__Host-arc_session" if self.cookie_secure else "arc_session"

    @model_validator(mode="after")
    def check_secrets(self) -> Settings:
        if self.signing_kid not in self.signing_keys:
            raise ValueError("ARC_SIGNING_KEYS must contain ARC_SIGNING_KID")
        for kid, key in self.signing_keys.items():
            if len(key.get_secret_value()) < MIN_SECRET_LEN:
                raise ValueError(f"signing key {kid!r} must be at least {MIN_SECRET_LEN} chars")
        if len(self.recovery_pepper.get_secret_value()) < MIN_SECRET_LEN:
            raise ValueError(f"ARC_RECOVERY_PEPPER must be at least {MIN_SECRET_LEN} chars")
        if self.env == "production":
            self.check_production()
        return self

    def check_production(self) -> None:
        problems = []
        if not self.cookie_secure:
            problems.append("ARC_COOKIE_SECURE must be true")
        if self.expose_docs:
            problems.append("ARC_EXPOSE_DOCS must be false")
        if not self.hsts:
            problems.append("ARC_HSTS must be true")
        if any(o.startswith("http://") for o in self.allowed_origins):
            problems.append("ARC_ALLOWED_ORIGINS must be https")
        if problems:
            raise ValueError("unsafe production settings: " + "; ".join(problems))


@lru_cache
def get_settings() -> Settings:
    return Settings()
