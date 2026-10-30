# syntax=docker/dockerfile:1.7
# Build context: repository root.

FROM rust:1.90-slim-bookworm AS wasm
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && rustup target add wasm32-unknown-unknown \
 && cargo install --locked wasm-pack --version 0.13.1
WORKDIR /src
COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY crates ./crates
# --no-opt everywhere (same as `pnpm wasm`), so CI, local and production run the exact
# same artifact. A separate wasm-opt (Debian's older binaryen) once produced a module
# that crashed at start ("WebAssembly.Table.grow(): failed to grow table").
RUN mkdir -p apps/web/src/wasm \
 && wasm-pack build crates/arc-engine-wasm --release --no-opt --target web \
      --out-dir ../../apps/web/src/wasm/pkg --out-name arc_engine

FROM node:22-slim AS web
RUN corepack enable
WORKDIR /src/apps/web
COPY apps/web/package.json apps/web/pnpm-lock.yaml apps/web/pnpm-workspace.yaml ./
RUN --mount=type=cache,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile
COPY apps/web ./
COPY --from=wasm /src/apps/web/src/wasm/pkg ./src/wasm/pkg
RUN pnpm build

# ---- Test-only stages, used by infra/docker-compose.e2e.yml (`make e2e-docker`).
# They must stay ABOVE the production stage: `docker build` builds the last stage.

# The production build, served by `vite preview` with the production CSP.
FROM web AS preview
EXPOSE 4173
CMD ["pnpm", "preview", "--host", "0.0.0.0"]

# Playwright on Linux with headless Chromium and no GPU: the same conditions as CI.
# Keep the tag equal to the @playwright/test version in pnpm-lock.yaml.
FROM mcr.microsoft.com/playwright:v1.64.1-noble AS e2e
RUN corepack enable
WORKDIR /src/apps/web
COPY apps/web/package.json apps/web/pnpm-lock.yaml apps/web/pnpm-workspace.yaml ./
RUN --mount=type=cache,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile
COPY apps/web/playwright.config.ts apps/web/tsconfig.json apps/web/tsconfig.node.json ./
COPY apps/web/e2e ./e2e
CMD ["pnpm", "exec", "playwright", "test"]

# ---- Production image (default target).
FROM caddy:2-alpine
COPY infra/Caddyfile /etc/caddy/Caddyfile
COPY --from=web /src/apps/web/dist /srv
