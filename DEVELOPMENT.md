# Developing Arc Zero locally

Everything below runs through `make`. Run `make` on its own to list every command.

## 1. Install the tools (once)

| Tool | Why | Install (macOS) |
|---|---|---|
| Rust | game engine, level generator | `curl https://sh.rustup.rs -sSf \| sh` (the repo pins the version in `rust-toolchain.toml`) |
| wasm-pack | builds the engine for the browser | `brew install wasm-pack` |
| uv | Python and the API's dependencies | `brew install uv` |
| Node 22 + pnpm | web app | `brew install node@22 pnpm` |
| Docker Desktop | Postgres, Redis, the CI-identical e2e run | docker.com |

Then check: `make doctor`

## 2. First-time setup

```bash
make setup
```

This creates `apps/api/.env` with fresh **local-only** secrets, starts Postgres
(`localhost:55432`) and Redis (`localhost:56379`) in Docker, installs dependencies,
builds the WASM engine, generates levels into `apps/api/levels.json` and applies the
database migrations. Safe to run again: it never overwrites your `.env`.

## 3. Day to day

```bash
make dev     # API (:8000) + game (:5173) in one terminal; Ctrl+C stops both
```

Or in two terminals, if you prefer separate logs: `make api` and `make web`.

**Playtesting any level:** `make dev-unlocked` opens every level (no unlock order, no
level-3 gate) so you can jump straight to level 80 and judge the difficulty. A banner
on the home screen shows when it's on. Wins are still verified. The setting is
`ARC_DEV_UNLOCK_ALL=true`, and the API refuses to start with it in production.

Open **http://localhost:5173**. Use `localhost`, not `127.0.0.1`: the API only accepts
requests from the origins listed in `apps/api/.env`, and blocks others with a 403.

| You changed… | Run |
|---|---|
| anything in `crates/` (Rust) | `make engine` (rebuilds it for the browser and the API), then restart `make api` |
| the level generator | `make levels`, then restart `make api` |
| a database model | add an Alembic migration in `apps/api/migrations/versions/`, then `make migrate` |
| game rules (anything that changes a turn's result) | `UPDATE_GOLDEN=1 cargo test -p arc-engine --test golden`, then `make test` |

Stop the database and Redis with `make services-down` (data is kept).

## 4. Testing

| Command | What it checks | Time |
|---|---|---|
| `make test-rust` | engine rules, solver, physics, golden vectors | ~5 s |
| `make test-api` | every API flow and every cheat in the threat model | ~5 s |
| `make test-web` | web unit tests + WASM gives the same result as native Rust | ~5 s |
| `make lint` | rustfmt, clippy, ruff, mypy (strict), eslint, tsc | ~1 min |
| `make check` | all of the above | ~1–2 min |
| `make e2e` | browser plays both games in **your** Chrome (needs `make api` + `make preview` running) | ~15 s |
| `make e2e-docker` | the same browser tests **under CI conditions**: Linux, headless Chromium with no GPU, the production API image, the production web build under the production CSP | ~1 min (first run builds images: ~15 min) |
| `make ci` | `check` + `e2e-docker`: everything CI runs | |

**Before opening a pull request, run `make ci`.** If it passes locally, CI passes:
`e2e-docker` exists because a test can pass in your Chrome (real GPU) and fail on
CI's GPU-less Linux machines. That has happened: WebGL in software mode logs driver
warnings your Mac never shows.

When an e2e test fails, its trace is saved under `apps/web/test-results/`. Open it with
`cd apps/web && pnpm exec playwright show-trace test-results/<test>/trace.zip`.
If a Docker e2e run was interrupted, clean it up with `make e2e-docker-down`.

## 5. How changes reach production

```
your branch ──PR──▶ CI (Rust, API, web, e2e) ──"CI passed"──▶ merge to main ──▶ release/YY.MM.XX ──▶ deploy
```

- `main` accepts only pull requests whose **CI passed** check is green. Nobody can bypass it.
- Releases deploy only commits already on `main`. See the readme, "Releasing".

## 6. Troubleshooting

| Symptom | Fix |
|---|---|
| `403 forbidden_origin` in the browser | open `localhost`, not `127.0.0.1`; or add your origin to `ARC_ALLOWED_ORIGINS` in `apps/api/.env` |
| API fails at start: `levels.json` not found | `make levels` |
| `connection refused` on 55432 / 56379 | `make services` (is Docker Desktop running?) |
| game logic changed but the browser behaves the old way | `make wasm`, then hard-reload (the service worker caches the old build in `make preview`) |
| web app fails to import `src/wasm/pkg/...` | `make wasm` (that folder is generated, not committed) |
| e2e Docker run left containers behind | `make e2e-docker-down` |
