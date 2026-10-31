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

## Development and testing

See **[DEVELOPMENT.md](DEVELOPMENT.md)**. In short:

```bash
make setup        # once: secrets, Postgres + Redis, dependencies, WASM, levels, DB
make dev          # play: http://localhost:5173 (API + web in one terminal)
make ci           # before a PR: every check CI runs, incl. e2e in Docker under CI conditions
```

## Deploying

Production runs at **https://play.pwnchaurasia.dev** on a DigitalOcean droplet that also
hosts other sites. The host's nginx terminates TLS and forwards to the app container,
which serves the app and proxies `/api` to FastAPI, all on one origin. Postgres is
hosted elsewhere (encrypted connection), so losing the droplet loses no player data.

### Releasing

Each change is tested **once**, on its pull request:

```
feature branch ──PR──▶ CI (engine, API, web, e2e) ──merge──▶ main ──branch release/YY.MM.XX──▶ deploy
                       the only test run                    no CI      checks the commit is on main,
                                                                       builds images, deploys
```

```bash
git switch main && git pull
git switch -c release/26.10.01        # YY.MM.XX: year, month, release number that month
git push -u origin release/26.10.01
```

`.github/workflows/release.yml` then:
1. rejects any other branch name format,
2. refuses commits that are not on `main` (so untested code can't be deployed),
3. builds the API and web images and pushes them to `ghcr.io/pwnchaurasia/arc-zero-{api,web}:YY.MM.XX`,
4. writes the config from GitHub secrets, uploads it over SSH and runs `infra/deploy/activate.sh`,
   which starts the release and waits until every service is healthy,
5. checks `https://play.pwnchaurasia.dev/api/v1/ready` through nginx.

**`main` only accepts tested pull requests**, enforced by the ruleset in
`.github/rulesets/main.json`: repo → Settings → Rules → Rulesets → New ruleset →
**Import a ruleset** → choose that file → Create. It:
- requires a pull request (no direct pushes to `main`),
- requires the `CI passed` check, which succeeds only if every CI job succeeded,
- requires the branch to be up to date with `main`, so what was tested is exactly what lands,
- blocks force-pushes and deleting `main`,
- has **no bypass list**: nobody, including repository admins, can merge without green CI.

**Rollback:** cut a new release branch from an older commit on `main`, e.g.
`git switch -c release/26.10.03 <old-commit> && git push -u origin release/26.10.03`.
For an instant rollback without CI, set `IMAGE_TAG=<previous version>` in `/opt/arc-zero/.env`
on the server and run `docker compose up -d`.

### One-time server setup (DigitalOcean droplet, shared with other sites)

```
internet ─▶ nginx (host, :443, Let's Encrypt) ─▶ 127.0.0.1:8080 ─▶ web container (Caddy)
                                                                     ├─ static app
                                                                     └─ /api ─▶ api ─▶ hosted Postgres (TLS)
                                                                                   └─▶ redis (container)
```

1. **DNS:** `A` record `play` → droplet IP (and `AAAA` if the droplet has IPv6).
2. **Firewall:** 22, 80, 443 open (already the case for the Hugo site). Port 8080 stays
   private: the container binds `127.0.0.1` only.
3. **Docker:** `curl -fsSL https://get.docker.com | sh`
4. **Deploy user and key** (a key used only by GitHub, never your personal one):
   ```bash
   sudo useradd -m -s /bin/bash -G docker deploy
   sudo mkdir -p /opt/arc-zero/secrets && sudo chown -R deploy:deploy /opt/arc-zero && sudo chmod 700 /opt/arc-zero
   ssh-keygen -t ed25519 -f ~/arc-deploy -N "" -C github-deploy
   sudo mkdir -p /home/deploy/.ssh && sudo sh -c "cat ~$USER/arc-deploy.pub >> /home/deploy/.ssh/authorized_keys"
   sudo chown -R deploy:deploy /home/deploy/.ssh && sudo chmod 700 /home/deploy/.ssh
   cat ~/arc-deploy        # → GitHub secret DEPLOY_SSH_KEY, then: rm ~/arc-deploy
   ```
   The docker group is root-equivalent: keep this key only in GitHub.
5. **TLS certificate + nginx site:**
   ```bash
   sudo mkdir -p /var/www/letsencrypt
   # 5a. HTTP-only first (just the first server{} block of infra/nginx/play.pwnchaurasia.dev.conf)
   sudo certbot certonly --webroot -w /var/www/letsencrypt -d play.pwnchaurasia.dev
   # 5b. then install the full file and reload
   sudo cp play.pwnchaurasia.dev.conf /etc/nginx/sites-available/
   sudo ln -s /etc/nginx/sites-available/play.pwnchaurasia.dev.conf /etc/nginx/sites-enabled/
   sudo nginx -t && sudo systemctl reload nginx
   ```
   Certbot's timer renews the certificate; add `--deploy-hook "systemctl reload nginx"` once
   with `sudo certbot reconfigure --cert-name play.pwnchaurasia.dev --deploy-hook "systemctl reload nginx"`.
6. **Database (hosted Postgres):** create one database and one user just for this app
   (never reuse an admin user across projects), e.g. `arc_zero` / `arc_zero`. Use the
   *direct* connection string, not a pgbouncer "pooler" one. Pick a region close to the
   droplet: every game request reads it.
7. **GitHub** (repo → Settings → Environments → `production`). All configuration lives
   here; every release writes it to `/opt/arc-zero/secrets/` on the server, so the server
   holds nothing you set by hand and a new droplet only needs steps 1–5.

   | Secret | Value |
   |---|---|
   | `DEPLOY_HOST` | droplet IP |
   | `DEPLOY_USER` | `deploy` |
   | `DEPLOY_SSH_KEY` | private half of the deploy key (whole file) |
   | `DEPLOY_KNOWN_HOSTS` | `ssh-keyscan -t ed25519 <droplet-ip>`, checked against `/etc/ssh/ssh_host_ed25519_key.pub` |
   | `ARC_DATABASE_URL` | `postgresql+asyncpg://user:pass@host:port/db?ssl=require` (provider URL with `+asyncpg`, `sslmode`→`ssl`, other options removed) |
   | `ARC_SIGNING_KEYS` | `{"k1": "<random 48+ chars>"}` |
   | `ARC_RECOVERY_PEPPER` | random 48+ chars. **Also keep in your password manager: losing it breaks every recovery key** |
   | `REDIS_PASSWORD` | random letters and digits |
   | `ARC_LEVEL_SEED` | random 48+ chars. **Also keep in your password manager: the same seed rebuilds the same levels** |

   Generate the random ones with `python3 -c "import secrets;print(secrets.token_hex(32))"`.

   | Variable | Value |
   |---|---|
   | `SITE_ADDRESS` | `play.pwnchaurasia.dev` |
   | `ARC_SIGNING_KID` | `k1` (optional; for key rotation) |
   | `DEPLOY_PORT`, `DEPLOY_DIR` | optional |

   Changing a secret takes effect on the next release. Levels are regenerated from the
   seed on every deploy, so changing the generator code changes the levels: do that deliberately.

The API refuses to start in production unless cookies are Secure, HSTS is on, docs are
hidden, every origin is HTTPS and the database connection is encrypted.

### Backups

`.github/workflows/backup.yml` runs every night at 03:00 IST on GitHub (not on the droplet):
`pg_dump` → encrypted with [age](https://age-encryption.org) → DigitalOcean Spaces.

Setup, once:
1. **Encryption key** (on your laptop): `age-keygen -o arc-backup.key`. Put the whole file in
   your password manager and delete it from disk. The `# public key: age1…` line is the
   recipient. GitHub only ever sees the public key, so backups can't be read with GitHub access.
2. **Spaces:** create a private bucket (e.g. `pwn-backups`, region `blr1`) and an access key
   limited to that bucket.
3. **Retention** (keeps 30 days, so the job never needs delete rights):
   ```bash
   aws s3api put-bucket-lifecycle-configuration --endpoint-url https://blr1.digitaloceanspaces.com \
     --bucket pwn-backups --lifecycle-configuration \
     '{"Rules":[{"ID":"expire-30d","Status":"Enabled","Prefix":"arc-zero/","Expiration":{"Days":30}}]}'
   ```
4. **GitHub** (Settings → Environments → `production`, next to the deploy secrets):
   - secrets: `BACKUP_DATABASE_URL` (libpq form: `postgresql://user:pass@host:port/arc_zero?sslmode=require`),
     `BACKUP_S3_ACCESS_KEY`, `BACKUP_S3_SECRET_KEY`;
   - variables: `BACKUP_AGE_RECIPIENT` (`age1…`), `BACKUP_S3_BUCKET`; optional
     `BACKUP_S3_ENDPOINT` (default Bangalore `blr1`), `BACKUP_PG_IMAGE` (default `postgres:17-alpine`;
     must be the server's major version or newer).
5. Run it once by hand: Actions → Nightly database backup → Run workflow.

If the hosted database only accepts allow-listed IPs, GitHub's runners need access too.

**Restore** (test this every few months, or a backup is only a hope):
```bash
aws s3 cp s3://pwn-backups/arc-zero/<file>.dump.age . --endpoint-url https://blr1.digitaloceanspaces.com
age --decrypt -i arc-backup.key <file>.dump.age > arc.dump
pg_restore --no-owner --clean --if-exists -d "postgresql://…?sslmode=require" arc.dump
```

### Rotating the signing key

Add a new key to the `ARC_SIGNING_KEYS` secret, point the `ARC_SIGNING_KID` variable at it, release, and
remove the old key after 7 days (the longest guest-ticket lifetime). Never change
`ARC_RECOVERY_PEPPER`: it would invalidate every recovery key.
