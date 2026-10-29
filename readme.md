# Arc Zero

Ad-free, tracker-free puzzle games for the mobile web. Two games ship in v1:
**Water Sort** and **Brick Blast**, with 100 levels each.

The server is the only source of truth. Players send their moves; the server
re-runs every move with the same Rust engine the browser uses and decides
what was won. Nothing the client claims about levels, stars or hints is trusted.

## Architecture

```
crates/arc-engine        Rust game rules: deterministic, integer-only physics
  ├─ arc-engine-wasm     → WebAssembly for the browser (animation, aim guide, PoW)
  ├─ arc-engine-py       → native Python module for the API (verification)
  └─ arc-levelgen        → offline generator: 100 proven-finishable levels per game
apps/api                 FastAPI (uv) · PostgreSQL · Redis
apps/web                 Vite · React · Tailwind · PixiJS (WebGL) · PWA
infra/                   Caddy (TLS + CSP), docker compose
```

One engine compiled to two targets is what makes the anti-cheat work: the
browser and the server cannot disagree about a pour or a bounce. Golden vectors
(`crates/arc-engine/tests/golden/`) are checked against native Rust, WASM and
Python in CI.

## Security model (summary)

| Threat | Defence |
| --- | --- |
| Skipping levels | Progress lives in Postgres; `/start` refuses locked levels |
| Faking a win | Water Sort: server replays the move list. Brick Blast: server simulates every turn |
| Seeing future levels | Levels are server-only (generated from a secret seed); Brick Blast rows are revealed one turn at a time |
| Replaying requests | Single-use attempt ids, turn counters, per-run locks |
| Registration spam | Guests have no DB rows; signed guest tickets prove the level-3 gate; proof-of-work; IP rate limits; PoW difficulty rises during surges |
| Guessing recovery keys | 6 BIP-39 words (~66 bits), generated server-side, stored as HMAC with a pepper |
| Hint abuse | 3 per game per UTC day, atomic DB counter, one move per hint |
| XSS / CSRF | Strict CSP (no inline, no eval, no third parties), httpOnly SameSite=Strict session cookie, Origin checks, JSON-only writes |

We cannot stop a bot that genuinely solves puzzles; there are no leaderboards, so there is little reason to.

## Development

Prerequisites: Rust (pinned by `rust-toolchain.toml`), wasm-pack, uv, Node 22 + pnpm, Docker.

```bash
docker compose -f infra/docker-compose.dev.yml up -d       # Postgres :55432, Redis :56379

# API
cd apps/api
cp .env.example .env                                       # fill in the secrets
ARC_LEVEL_SEED=$(python3 -c "import secrets;print(secrets.token_urlsafe(48))") \
  cargo run --release -p arc-levelgen -- --out levels.json
uv sync && uv run alembic upgrade head
uv run uvicorn --factory arc_api.main:app --reload --no-access-log

# Web (another terminal)
cd apps/web
pnpm install && pnpm wasm && pnpm dev                      # http://localhost:5173
```

## Checks

```bash
cargo fmt --all -- --check && cargo clippy --all-targets -- -D warnings && cargo test
cd apps/api && uv run ruff check . && uv run mypy src tests && uv run pytest
cd apps/web && pnpm lint && pnpm typecheck && pnpm test && pnpm determinism && pnpm build
```

### E2E

Runs the production build under the production CSP against a live API:

```bash
cd apps/web && pnpm build && pnpm preview &                # :4173 with CSP headers
E2E_CHANNEL=chrome pnpm e2e                                # or `playwright install chromium`
```

`ARC_ALLOWED_ORIGINS` must include `http://localhost:4173`.

## Deploying

Production runs at **https://play.pwnchaurasia.dev** on a single server with
Docker. Caddy terminates TLS (certificates are automatic), serves the app and
proxies `/api` to FastAPI, all on one origin.

### Releasing

Push a branch named `release/YY.MM.XX` (year, month, release number that month):

```bash
git switch main && git pull
git switch -c release/26.10.01
git push -u origin release/26.10.01
```

`.github/workflows/release.yml` then:
1. rejects any other branch name format,
2. runs the full CI suite (engine, API, web, e2e under the production CSP),
3. builds the API and web images and pushes them to `ghcr.io/pwnchaurasia/arc-zero-{api,web}:YY.MM.XX`,
4. SSHes to the server, pulls those images, runs migrations and restarts,
5. fails the release if `https://play.pwnchaurasia.dev/api/v1/ready` is not healthy.

**Rollback:** on the server, set `IMAGE_TAG=<previous version>` in `/opt/arc-zero/.env`
and run `docker compose up -d`. (Migrations are additive; check before rolling back across one that is not.)

### One-time server setup

1. **DNS:** `A` (and `AAAA` if you have IPv6) record `play.pwnchaurasia.dev` → server IP.
2. **Firewall:** allow 22, 80 and 443 (TCP) plus 443/UDP (HTTP/3). Nothing else needs to be public.
3. **Docker:** install Docker Engine with the compose plugin.
4. **Deploy user:** `sudo useradd -m -G docker deploy`, then add the public half of a
   new, dedicated SSH key (`ssh-keygen -t ed25519 -f arc-deploy -N ""`) to
   `/home/deploy/.ssh/authorized_keys`. Note: the docker group is root-equivalent; use this key only for deploys.
5. **App directory** (owned by `deploy`, mode 700):
   ```
   /opt/arc-zero/
     .env                    SITE_ADDRESS=play.pwnchaurasia.dev
                             ACME_EMAIL=<your email>
     secrets/api.env         from infra/api.env.example (ARC_ALLOWED_ORIGINS=["https://play.pwnchaurasia.dev"],
                             ARC_ALLOWED_HOSTS=["play.pwnchaurasia.dev","127.0.0.1"])
     secrets/postgres_password
     secrets/redis_password
     secrets/levels.json     generated on your machine, then scp'd here
   ```
   Generate the levels with a secret seed and keep that seed in your password manager
   (the same seed always regenerates the same levels):
   `ARC_LEVEL_SEED=<secret> cargo run --release -p arc-levelgen -- --out levels.json`
6. **GitHub** (repo → Settings): create an environment named `production`
   (optionally require your approval before deploys), then add
   - secrets: `DEPLOY_HOST`, `DEPLOY_USER` (`deploy`), `DEPLOY_SSH_KEY` (private key),
     `DEPLOY_KNOWN_HOSTS` (output of `ssh-keyscan -t ed25519 <host>`, verified against the server),
   - variables: `SITE_ADDRESS` = `play.pwnchaurasia.dev`, optionally `DEPLOY_PORT`,
     `DEPLOY_DIR`, `DEPLOY_PLATFORM` (`linux/arm64` for an ARM server).

The API refuses to start in production unless cookies are Secure, HSTS is on,
docs are hidden and every origin is HTTPS.

If the server already runs a web server on ports 80/443 (e.g. nginx for other
sites), Caddy cannot bind them; put this behind that server instead (ask before changing the compose file).

**Never commit** `.env`, `levels.json` or anything in `infra/secrets/`; `.gitignore` excludes them.

### Rotating the signing key

Add a new key to `ARC_SIGNING_KEYS`, point `ARC_SIGNING_KID` at it, deploy, and
remove the old key after 7 days (the longest guest-ticket lifetime). Never change
`ARC_RECOVERY_PEPPER`: it would invalidate every recovery key.
