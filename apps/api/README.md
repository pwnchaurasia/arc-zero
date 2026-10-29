# arc-api

FastAPI server for Arc Zero. It owns all progress and verifies every move with
the shared Rust engine (`crates/arc-engine-py`, built automatically by uv via maturin).

## Run locally

```bash
docker compose -f ../../infra/docker-compose.dev.yml up -d   # Postgres + Redis
cp .env.example .env                                         # then fill in secrets
uv sync
uv run alembic upgrade head
ARC_LEVEL_SEED=... cargo run --release -p arc-levelgen -- --out levels.json
uv run uvicorn --factory arc_api.main:app --reload --no-access-log
```

## Checks

```bash
uv run ruff check . && uv run ruff format --check .
uv run mypy src
uv run pytest
```

Tests need the dev Postgres and Redis from `infra/docker-compose.dev.yml`.

## Configuration

All settings are `ARC_*` environment variables; see `src/arc_api/config.py`
and `.env.example`. In production the app refuses to start unless cookies are
`Secure`, HSTS is on, docs are hidden and every origin is HTTPS.
