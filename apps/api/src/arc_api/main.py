"""FastAPI application factory."""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from anyio import CapacityLimiter
from fastapi import APIRouter, FastAPI
from redis.asyncio import Redis
from starlette.middleware.trustedhost import TrustedHostMiddleware

from arc_api import errors, levels
from arc_api.config import Settings, get_settings
from arc_api.db import make_engine, make_sessionmaker
from arc_api.routers import auth, brick_blast, me, meta, water_sort
from arc_api.security.middleware import RequestGuardMiddleware, SecurityHeadersMiddleware
from arc_api.security.ratelimit import RateLimiter
from arc_api.security.sessions import Sessions
from arc_api.security.signing import Signer
from arc_api.state import AppState

MAX_BODY_BYTES = 32 * 1024

log = logging.getLogger("arc_api")


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()
    logging.basicConfig(
        level=settings.log_level, format="%(asctime)s %(levelname)s %(name)s %(message)s"
    )

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        catalogue = levels.load(settings.levels_path)
        engine = make_engine(settings.database_url.get_secret_value())
        redis = Redis.from_url(settings.redis_url.get_secret_value())
        signer = Signer(
            {kid: k.get_secret_value().encode() for kid, k in settings.signing_keys.items()},
            settings.signing_kid,
        )
        app.state.arc = AppState(
            settings=settings,
            sessionmaker=make_sessionmaker(engine),
            redis=redis,
            signer=signer,
            limiter=RateLimiter(redis),
            sessions=Sessions(redis, settings.session_ttl_days * 86400),
            levels=catalogue,
            engine_slots=CapacityLimiter(settings.engine_threads),
        )
        log.info(
            "started: %d water sort levels, %d brick blast levels",
            len(catalogue.water_sort),
            len(catalogue.brick_blast),
        )
        try:
            yield
        finally:
            await redis.aclose()
            await engine.dispose()

    docs = settings.expose_docs
    app = FastAPI(
        title="Arc Zero API",
        version="0.1.0",
        lifespan=lifespan,
        docs_url="/api/docs" if docs else None,
        redoc_url=None,
        openapi_url="/api/openapi.json" if docs else None,
    )
    errors.install(app)

    api = APIRouter(prefix="/api/v1")
    for module in (meta, auth, me, water_sort, brick_blast):
        api.include_router(module.router)
    app.include_router(api)

    # Outermost first: headers wrap everything, then host check, then request guard.
    app.add_middleware(
        RequestGuardMiddleware, allowed_origins=settings.allowed_origins, max_body=MAX_BODY_BYTES
    )
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=settings.allowed_hosts)
    app.add_middleware(SecurityHeadersMiddleware, hsts=settings.hsts)
    return app


def app() -> FastAPI:
    """Factory entry point for `uvicorn --factory arc_api.main:app`."""
    return create_app()
