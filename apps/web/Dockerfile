# syntax=docker/dockerfile:1.7
# Build context: repository root.

FROM rust:1.90-slim-bookworm AS wasm
# binaryen from Debian: wasm-pack's own wasm-opt download has no aarch64 Linux build.
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates binaryen \
 && rm -rf /var/lib/apt/lists/* \
 && rustup target add wasm32-unknown-unknown \
 && cargo install --locked wasm-pack --version 0.13.1
WORKDIR /src
COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY crates ./crates
RUN mkdir -p apps/web/src/wasm \
 && wasm-pack build crates/arc-engine-wasm --release --no-opt --target web \
      --out-dir ../../apps/web/src/wasm/pkg --out-name arc_engine \
 && wasm-opt -O3 --enable-bulk-memory --enable-nontrapping-float-to-int --enable-sign-ext \
      apps/web/src/wasm/pkg/arc_engine_bg.wasm -o apps/web/src/wasm/pkg/arc_engine_bg.wasm

FROM node:22-slim AS web
RUN corepack enable
WORKDIR /src/apps/web
COPY apps/web/package.json apps/web/pnpm-lock.yaml apps/web/pnpm-workspace.yaml ./
RUN --mount=type=cache,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile
COPY apps/web ./
COPY --from=wasm /src/apps/web/src/wasm/pkg ./src/wasm/pkg
RUN pnpm build

FROM caddy:2-alpine
COPY infra/Caddyfile /etc/caddy/Caddyfile
COPY --from=web /src/apps/web/dist /srv
