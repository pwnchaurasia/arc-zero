# Arc Zero developer commands. Run `make` (or `make help`) to list them.
# Works with the GNU Make 3.81 that ships with macOS.

SHELL := /bin/bash
DEV := docker compose -f infra/docker-compose.dev.yml
E2E := docker compose -f infra/docker-compose.e2e.yml
# Not a secret: local development levels only. Production uses ARC_LEVEL_SEED from GitHub.
DEV_LEVEL_SEED := dev-only-level-seed-not-secret-0123456789abcdef

.DEFAULT_GOAL := help
.PHONY: help doctor setup env services services-down levels wasm engine migrate dev api web preview \
	test test-rust test-api test-web lint fmt check e2e e2e-docker e2e-docker-down ci clean

help: ## List commands
	@grep -E '^[a-z0-9-]+:.*## ' $(MAKEFILE_LIST) \
	  | awk 'BEGIN {FS = ":.*## "} {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

# ---------------------------------------------------------------- setup

doctor: ## Check the required tools are installed
	@ok=1; for t in cargo wasm-pack uv node pnpm docker; do \
	  if command -v $$t >/dev/null; then printf "  ok       %s\n" $$t; \
	  else printf "  MISSING  %s\n" $$t; ok=0; fi; done; \
	  docker info >/dev/null 2>&1 || { echo "  Docker is installed but not running"; ok=0; }; \
	  [ $$ok = 1 ] || { echo "Install the missing tools (see DEVELOPMENT.md)"; exit 1; }

setup: doctor env services ## One-time setup: secrets, services, deps, WASM, levels, DB
	cd apps/api && uv sync
	cd apps/web && pnpm install --frozen-lockfile
	$(MAKE) wasm levels migrate
	@echo; echo "Ready. Run 'make api' and 'make web' in two terminals, then open http://localhost:5173"

env: ## Create apps/api/.env with fresh local secrets (never overwrites)
	python3 tools/dev_env.py

services: ## Start local Postgres (:55432) and Redis (:56379)
	$(DEV) up -d --wait

services-down: ## Stop local Postgres and Redis (data is kept)
	$(DEV) down

levels: ## Generate local levels into apps/api/levels.json
	ARC_LEVEL_SEED=$(DEV_LEVEL_SEED) cargo run --release -p arc-levelgen -- --out apps/api/levels.json

wasm: ## Build the Rust engine for the browser (after any change in crates/)
	cd apps/web && pnpm wasm

engine: wasm ## Rebuild the Rust engine for the browser and the API (after changing crates/)
	cd apps/api && uv sync --reinstall-package arc-engine

migrate: ## Apply database migrations
	cd apps/api && uv run alembic upgrade head

# ------------------------------------------------------------------ run

dev: services ## Play locally: API + web in one terminal, open http://localhost:5173 (Ctrl+C stops)
	@echo "Starting API (:8000) and web (:5173). Open http://localhost:5173 ; Ctrl+C stops both."
	@$(MAKE) -j2 --no-print-directory api web

api: ## Run the API with auto-reload on :8000
	cd apps/api && uv run uvicorn --factory arc_api.main:app --reload --no-access-log

web: ## Run the web app with hot reload on :5173
	cd apps/web && pnpm dev

preview: ## Serve the production build under the production CSP on :4173
	cd apps/web && pnpm build && pnpm preview

# ----------------------------------------------------------------- test

test: test-rust test-api test-web ## All unit and integration tests

test-rust: ## Rust engine tests (rules, physics, golden vectors)
	cargo test

test-api: services ## API tests (needs local Postgres and Redis)
	cd apps/api && uv run pytest -q

test-web: ## Web unit tests and WASM-vs-native determinism
	cd apps/web && pnpm test && pnpm determinism

lint: ## Every linter and type checker CI runs
	cargo fmt --all -- --check
	cargo clippy --all-targets -- -D warnings
	cd apps/api && uv run ruff check . && uv run ruff format --check . && uv run mypy src tests
	cd apps/web && pnpm lint && pnpm typecheck

fmt: ## Auto-format Rust and Python
	cargo fmt --all
	cd apps/api && uv run ruff format . && uv run ruff check --fix .

check: lint test ## Everything CI checks except e2e

e2e: ## Quick e2e in your own Chrome (needs 'make api' and 'make preview' running)
	cd apps/web && E2E_CHANNEL=chrome pnpm e2e

e2e-docker: ## Full e2e in Docker, same conditions as CI (Linux, no GPU, prod images)
	$(E2E) up -d --build --wait web
	@status=0; $(E2E) run --rm --build e2e || status=$$?; \
	  if [ $$status != 0 ]; then $(E2E) logs --tail 40 api web; \
	    echo "e2e failed; traces in apps/web/test-results (pnpm exec playwright show-trace <zip>)"; fi; \
	  $(E2E) down -v --remove-orphans >/dev/null 2>&1; exit $$status

e2e-docker-down: ## Remove the e2e stack if a run was interrupted
	$(E2E) --profile test down -v --remove-orphans

ci: check e2e-docker ## Everything CI runs, locally

clean: ## Remove build output (keeps dependencies and the database)
	rm -rf target apps/web/dist apps/web/dev-dist apps/web/src/wasm/pkg apps/web/test-results
