# syntax=docker/dockerfile:1.7
# Build context: repository root (the API links the Rust engine in crates/).

FROM python:3.13-slim-bookworm AS build
ENV RUSTUP_HOME=/opt/rustup CARGO_HOME=/opt/cargo PATH=/opt/cargo/bin:$PATH \
    UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=ghcr.io/astral-sh/uv:0.11 /uv /bin/uv
COPY rust-toolchain.toml /src/rust-toolchain.toml
RUN curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain none \
 && cd /src && rustup toolchain install  # reads rust-toolchain.toml
COPY Cargo.toml Cargo.lock /src/
COPY crates /src/crates
COPY apps/api/pyproject.toml apps/api/uv.lock apps/api/README.md /src/apps/api/
WORKDIR /src/apps/api
# Dependencies first (cached), then the app itself.
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-install-project --no-editable
COPY apps/api/src /src/apps/api/src
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-editable

FROM python:3.13-slim-bookworm AS runtime
RUN useradd --system --uid 10001 --home /app arc
WORKDIR /app
COPY --from=build /src/apps/api/.venv /app/.venv
COPY apps/api/alembic.ini /app/alembic.ini
COPY apps/api/migrations /app/migrations
ENV PATH=/app/.venv/bin:$PATH PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 \
    ARC_ENV=production ARC_LEVELS_PATH=/run/secrets/levels.json
USER arc
EXPOSE 8000
HEALTHCHECK --interval=15s --timeout=3s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/api/v1/health', timeout=2).status == 200 else 1)"
# Only reachable through Caddy on the private network, which sets X-Forwarded-For.
# No access log: we do not store player IP addresses.
CMD ["uvicorn", "--factory", "arc_api.main:app", "--host", "0.0.0.0", "--port", "8000", \
     "--workers", "2", "--proxy-headers", "--forwarded-allow-ips", "*", "--no-access-log", \
     "--no-server-header"]
