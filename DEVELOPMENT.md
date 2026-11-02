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
builds the WASM engine, generates levels into `apps/api/levels/` (one file per game) and applies the
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
| API fails at start: a levels file not found (e.g. `levels/water-sort.json`) | `make levels` (and check `ARC_LEVELS_PATH=levels` in `apps/api/.env`) |
| `connection refused` on 55432 / 56379 | `make services` (is Docker Desktop running?) |
| game logic changed but the browser behaves the old way | `make wasm`, then hard-reload (the service worker caches the old build in `make preview`) |
| web app fails to import `src/wasm/pkg/...` | `make wasm` (that folder is generated, not committed) |
| e2e Docker run left containers behind | `make e2e-docker-down` |

## Analytics (first-party, SQL only)

Every level start, clear, Brick Blast loss, hint, assist purchase and sign-up adds a row
to `play_events`. Nothing is sent anywhere else. `who` is a keyed one-way hash of the
player or guest id: it counts distinct players but can't be turned back into an account.
`signed_in` tells guests from saved players.

Connect with `psql` using the production `ARC_DATABASE_URL` (or your local dev database) and run:

```sql
-- Players per game per day (last 14 days)
SELECT day, game_id, count(DISTINCT who) AS players, count(*) FILTER (WHERE kind = 'start') AS starts
FROM play_events WHERE day > current_date - 14 AND game_id IS NOT NULL
GROUP BY day, game_id ORDER BY day DESC, game_id;

-- Daily active players across all games, guests vs saved
SELECT day, count(DISTINCT who) AS players,
       count(DISTINCT who) FILTER (WHERE signed_in) AS saved
FROM play_events WHERE day > current_date - 30 GROUP BY day ORDER BY day DESC;

-- Which levels are too hard: starts vs clears per level (low clear rate = wall)
SELECT game_id, level,
       count(*) FILTER (WHERE kind = 'start') AS starts,
       count(*) FILTER (WHERE kind = 'clear') AS clears,
       round(100.0 * count(*) FILTER (WHERE kind = 'clear')
             / nullif(count(*) FILTER (WHERE kind = 'start'), 0), 1) AS clear_pct
FROM play_events WHERE game_id = 'brick-blast'
GROUP BY game_id, level ORDER BY level;

-- How far players get: highest level cleared per player, as a distribution
SELECT game_id, max_level, count(*) AS players FROM (
  SELECT game_id, who, max(level) AS max_level FROM play_events
  WHERE kind = 'clear' GROUP BY game_id, who) t
GROUP BY game_id, max_level ORDER BY game_id, max_level;

-- Coins and assists
SELECT game_id, detail AS assist, count(*) AS bought, sum(coins) AS coins_spent
FROM play_events WHERE kind = 'assist' GROUP BY game_id, detail ORDER BY coins_spent DESC;

-- New saved players per day
SELECT day, count(*) FROM play_events WHERE kind = 'register' GROUP BY day ORDER BY day DESC;

-- Housekeeping: drop events older than a year
DELETE FROM play_events WHERE day < current_date - 365;
```

Coin balances and every coin change for saved players are in `wallets` and `coin_ledger`.

## Let friends play your local game (ngrok)

```sh
make share          # like `make dev`, but accepts requests through any ngrok address
ngrok http 5173     # in a second terminal; send friends the https://….ngrok-free.app URL
```

- Sharing mode (`ARC_DEV_TUNNEL=true`) lets `*.ngrok-free.app`, `*.ngrok.app` and
  `*.ngrok.io` reach the dev server and the API. Other sites stay blocked, and production
  refuses to start with it set.
- Friends play as guests on your machine and your database: progress, coins and analytics
  land in your local data. Stop `make share` and ngrok when you're done.
- ngrok's free plan shows a one-time "You are about to visit…" page; friends tap **Visit Site**.
