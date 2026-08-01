# Deploy: self-hosted server + Cloudflare Tunnel

Run the whole stack on **your own machine**, exposed at **https://naar-y.com** through a
**Cloudflare Tunnel** — no open ports, no public IP, free edge TLS, hidden origin. Works
behind home NAT/CGNAT. Cost: **$0** beyond electricity (Cloudflare free, your hardware).

```
Browser ──HTTPS──▶ Cloudflare edge (TLS · DDoS · DNS)
                        │  outbound tunnel (encrypted)
                        ▼
  YOUR SERVER (docker compose):
     cloudflared ─▶ web(nginx:80) ─/api─▶ api:3000
                    postgres(pgvector) · temporal(start-dev) · worker · migrate
  Firewall: inbound = SSH only. 80/443 CLOSED.
```

> **Prefer not to run your own hardware?** See **[Variant B — Hetzner + Neon +
> GitHub Actions](#variant-b--hetzner--neon--github-actions)** below: the same
> Terraform also provisions a Hetzner VPS and a Neon (managed Postgres) project,
> and a GitHub Actions workflow redeploys on every green `main`.

## What's here
| File | Purpose |
|---|---|
| `terraform/` | Cloudflare tunnel + ingress + DNS record, **plus** (Variant B) the Hetzner server (`hetzner.tf` + `cloud-init.yaml.tftpl`) and Neon Postgres (`neon.tf`). |
| `docker-compose.prod.yml` | Overlay on the repo's base compose: closes all ports, adds `cloudflared`. |
| `docker-compose.neon.yml` | Second overlay (Variant B): DB = Neon; gates the local postgres off, splits pooled vs direct URLs. |
| `docker-compose.ghcr.yml` | Third overlay (Variant B): run prebuilt `ghcr.io/…:${APP_VERSION}` images; `!reset`s all on-box builds. |
| `.env.prod.example` | Template for the server `.env` (copy to repo-root `.env`). Variant B generates this via Terraform instead. |
| `backup.sh` | Nightly `pg_dump` + Temporal DB → local (+ optional rclone off-box). **Not needed on Variant B** — Neon has PITR and Temporal is Cloud. |
| `../.github/workflows/deploy.yml` | CD: after CI passes on `main`, SSH-deploys to the Hetzner box. |

## Prerequisites
- **A Linux server** with Docker + Docker Compose v2 (≥ 2.24 for the `!override` in the overlay). ~8 GB RAM recommended (Postgres + Temporal + 3 Node services). x86 or ARM — images build on-box.
- **`naar-y.com` on Cloudflare** (nameservers → Cloudflare). ✅ You have this.
- **Terraform ≥ 1.5** on your laptop.
- A **Cloudflare API token** (Account → *Cloudflare Tunnel: Edit* + Zone → *DNS: Edit* on `naar-y.com`), your **Account ID** and the **Zone ID** (both in the dashboard sidebar).

---

> **Note:** the Terraform config now provisions the **full Variant B footprint**
> (tunnel + Hetzner server + Neon) on every `apply`, and `hcloud_token` /
> `neon_api_key` are required inputs. To run Variant A (tunnel only, your own
> hardware), delete `terraform/hetzner.tf`, `terraform/neon.tf` and their variables —
> both files are self-contained by design (see their headers).

## Step 1 — Cloudflare side (Terraform, on your laptop)

```bash
cd deploy/terraform
cp terraform.tfvars.example terraform.tfvars   # fill in token + account/zone IDs
terraform init
terraform apply
```

This creates the tunnel, its ingress rule (`naar-y.com → http://web:80`), and the proxied
CNAME. Grab the token for the server:

```bash
terraform output -raw tunnel_token
```

> **Provider version note:** this config targets the **Cloudflare provider v4.40**. On **v5**,
> rename: `cloudflare_zero_trust_tunnel_cloudflared_config` keeps its name, `cloudflare_record`
> → `cloudflare_dns_record` (and its `value` → `content`). Pin `~> 4.40` in `versions.tf` to use
> as-is.

## Step 2 — The server

```bash
# 1. Get the code
git clone <your-repo-url> naary && cd naary

# 2. Configure secrets
cp deploy/.env.prod.example .env
#   edit .env:  POSTGRES_PASSWORD (openssl rand -base64 24),
#               ENCRYPTION_KEY   (openssl rand -hex 32),
#               CLOUDFLARE_TUNNEL_TOKEN (from Step 1),
#               (optional) Firebase for browser login — else API-token mode.
chmod 600 .env

# 3. Bring it up (builds the images on-box; first build takes a few minutes)
docker compose -f docker-compose.yml -f deploy/docker-compose.prod.yml up -d --build
```

`migrate` runs Prisma migrations once, then `api`/`worker` start; `cloudflared` connects the
tunnel. Give it ~1–2 min.

## Step 3 — Verify

```bash
docker compose ps                 # all Up; api healthy; cloudflared connected
docker compose logs -f cloudflared   # "Registered tunnel connection" x4
```

Then open **https://naar-y.com**. First run: no users — either configure Firebase (browser
login) or mint an `nry_` **API token** and paste it on the sign-in screen for API-token mode.

**Smoke test the integrations:** Integrations → connect a GitHub PAT → build a workflow with a
**GitHub → Create issue** node → run it → confirm the issue appears and the node output shows
`status: 201`. (See `docs/integrations/github.md`.)

---

## Operations

**Update to a new version**
```bash
git pull
docker compose -f docker-compose.yml -f deploy/docker-compose.prod.yml up -d --build
```

**Backups (do this — your data lives only on this box)**
```bash
chmod +x deploy/backup.sh
crontab -e
#  15 3 * * *  cd /path/to/naary && ./deploy/backup.sh >> /var/log/naary-backup.log 2>&1
```
Set `BACKUP_RCLONE_REMOTE` in `.env` (e.g. `r2:naary-backups`) to also ship them off-box.

**Temporal Web UI** (not exposed): `ssh -L 8233:localhost:8233 <server>` → http://localhost:8233

**Postgres shell:** `docker compose exec postgres psql -U naary -d naary_orchestrator`

**Logs:** `docker compose logs -f api worker`

## Notes & trade-offs
- **Uptime = your machine + your internet.** Fine for a smoke test; for real use keep it always-on (UPS helps).
- **Single point of failure** — one box, no HA. Backups are your recovery path.
- **Isolate the box** on a separate VLAN/guest network if you can (attack surface is already small — no inbound ports).
- **Free-plan upload cap:** Cloudflare's free tier limits proxied request bodies to ~100 MB. Fine for the API/webhooks.

---

## Variant B — Hetzner + Neon + GitHub Actions

Same architecture (tunnel in front, no inbound web ports), but Terraform provisions
**everything**: the Cloudflare tunnel, a **Hetzner VPS** (default `cx33`, 4 vCPU / 8 GB,
~€7/mo, Nuremberg) and a **Neon** project (managed serverless Postgres, pgvector
included — so the RAG migrations run unchanged). The app DB and durable execution both
live off-box (Neon + Temporal Cloud), and the app itself arrives as **prebuilt images
from GHCR** — the box never sees source code, git, or a build. It holds exactly two
things: `/opt/naary/.env` and the compose files (re-shipped on every deploy).

```
Browser ──HTTPS──▶ Cloudflare edge ──tunnel──▶ Hetzner VPS (compose: cloudflared·web·api·worker·migrate)
                                                   │  ▲                     │
GitHub Actions ── build+push ─▶ GHCR ── pull ──────┘  │           Neon (Postgres+pgvector)
       └───────── SSH (deploy key): compose files ────┘           Temporal Cloud (durable exec)
```

### Provision (once, on your laptop)

1. Collect credentials into `terraform/terraform.tfvars` (see the example file):
   - **Hetzner** API token — console → your project → *Security → API tokens* (Read & Write).
   - **Neon** API key — console → *Account settings → API keys*.
   - **Cloudflare** token/IDs — as in Variant A above.
   - `ssh_public_key` — your personal key (admin access).
   - `deploy_ssh_public_key` — a **dedicated** CI keypair: `ssh-keygen -t ed25519 -f deploy_key -N ""`.
     Set it **before the first apply** (hcloud injects keys at create time only).
   - Recommended: the three `temporal_*` values (create the Temporal Cloud namespace +
     API key first), so the generated `.env` is complete. No repo access/PAT is needed —
     the box pulls prebuilt images.

2. Apply and grab outputs:
   ```bash
   cd deploy/terraform
   terraform init && terraform apply
   terraform output server_ipv4        # → GitHub secret DEPLOY_HOST
   terraform output -raw server_env    # the generated server .env — SAVE ENCRYPTION_KEY in a password manager
   ```

3. First boot: cloud-init installs Docker and writes `/opt/naary/.env` — that's all.
   The first *deploy* comes from GitHub Actions (next section). Watch the boot with
   `cloud-init status --wait` if you're curious.

The compose invocation layers **three** overlays (order matters; the Deploy workflow
runs this for you — shown here for manual ops/debugging on the box):
```bash
APP_VERSION=v0.0.1 docker compose -f docker-compose.yml -f deploy/docker-compose.prod.yml \
  -f deploy/docker-compose.neon.yml -f deploy/docker-compose.ghcr.yml up -d --no-build
```
`DATABASE_URL` (api/worker) uses Neon's **pooled** endpoint with `pgbouncer=true`;
`MIGRATE_DATABASE_URL` (the `migrate` one-shot) uses the **direct** endpoint — Prisma
migrations need a real session (advisory locks + DDL), not PgBouncer. The `ghcr` overlay
swaps every `build:` for `image: ghcr.io/…:${APP_VERSION}` (and `!reset`s the build
config so nothing can rebuild on the box).

### Object storage (S3) — required for form logos

`terraform/s3.tf` provisions a private bucket plus a **dedicated least-privilege IAM user**, and the
generated server `.env` picks up `STORAGE_PROVIDER`/`S3_BUCKET`/`AWS_REGION` and that user's key
automatically. Set `s3_bucket_name` in `terraform.tfvars` (bucket names are globally unique across all
AWS accounts, so pick something like `naary-prod-assets`) and `aws_region` near your box —
`eu-central-1` for Falkenstein/Nuremberg, since every logo view crosses this link.

The `aws` provider uses **your own** admin credentials (`AWS_PROFILE`, SSO, whatever you normally use)
purely to create the resources. The app never runs with those.

> **⚠️ On an EXISTING server, apply does not update `/opt/naary/.env`.** cloud-init runs on first boot
> only, and `hcloud_server.naary` deliberately sets `ignore_changes = [user_data]` so template edits
> can't replace a live box. Add the five lines by hand:
> ```bash
> terraform output -raw s3_secret_access_key   # and s3_access_key_id / s3_bucket / s3_region
> ssh root@$(terraform output -raw server_ipv4)
> # append STORAGE_PROVIDER / S3_BUCKET / AWS_REGION / AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY
> vi /opt/naary/.env && cd /opt/naary && docker compose up -d api worker
> ```

**One bucket, two lifetimes** — and the lifecycle rules reflect it:

| Prefix | Written by | Retention |
| --- | --- | --- |
| `form-assets/` | api (logo uploads) | **never expires** — a saved workflow references it and a public page renders it |
| `items/` `ctx/` `sql/` `http/` | worker (claim-checks: large activity outputs kept out of Temporal payloads) | `s3_claim_check_retention_days`, default 30 |

Expiring a claim-check is safe (the API falls back to the raw ctx and the UI shows an "offloaded"
marker); expiring a logo would silently break a customer-facing form, so `form-assets/` has no
expiration rule at all — only superseded versions are cleaned up. Incomplete multipart uploads are
aborted after 7 days, since those are billed but invisible in a listing.

**Why an access key and not a role:** there's no instance profile on a Hetzner VPS. The policy
compensates by granting exactly the two actions the code performs — `s3:GetObject` and `s3:PutObject`,
which is all `S3ObjectStore` ever calls. A leaked key can't list the bucket, delete a tenant's logo, or
touch encryption settings. Rotate with:

```bash
terraform taint aws_iam_access_key.naary[0] && terraform apply   # then update the server .env
```

**Not using AWS?** The store speaks to any S3-compatible service. Set `S3_ENDPOINT` in the server
`.env` for Cloudflare R2, Backblaze B2 or MinIO — that also switches the client to path-style
addressing, which those providers require. Set `create_s3 = false` to skip the AWS resources entirely
and configure the bucket yourself.

**Skipping it?** Everything else works; only hosted-form **logo uploads** fail, with a 503 naming the
missing variables. That's deliberate — see `s3.tf`.

### Releases & CD (GitHub Actions)

Deploys are **release-driven**, semver-tagged (`v0.0.1`):

1. **Cut a release:** *Actions → Release → Run workflow* → `version = 0.0.1` (or `v0.0.1`).
   `release.yml` bumps **every** workspace `package.json` (root + `apps/*` + `packages/*`)
   to that version, commits `chore(release): v0.0.1` to `main`, tags it, publishes a
   GitHub Release with generated notes — then chains straight into the deploy.
2. **Build** (`deploy.yml`, build job): builds `ghcr.io/<owner>/naary-backend:<tag>` and
   `…/naary-web:<tag>` in CI (gha layer cache) and pushes to GHCR — **unless both tags
   already exist**, so re-runs/rollbacks reuse the exact original artifact. The web
   image bakes `VITE_*` from repo **variables** and `VITE_APP_VERSION=<tag>`.
2b. **Sandbox images** (`deploy.yml` → `sandbox-images.yml`): the four codeAgent sandbox
   images (`naary-{claude,cursor,copilot,gemini}-sandbox`) are built + pushed to GHCR here
   too — never on the box. They are tagged by **content**
   (`sha-<hash of IMAGE_EPOCH + tool + that tool's Dockerfile>`), not by release tag: ~1.7GiB
   of coding CLIs that change monthly must not be rebuilt on every release, so the job skips
   the build whenever the tag already exists and just resolves the existing **digest**.
   Force a rebuild without a Dockerfile change (base-image CVE refresh; cursor's installer is
   an unpinned remote script) by bumping `EPOCH` in `deploy/sandbox/IMAGE_EPOCH`.
   The job's outputs are `<ref>@sha256:<digest>` — the runner holds the host Docker socket, so
   what it launches must be immutable bytes, not a re-pushable tag.
3. **Deploy** (`deploy.yml`, deploy job): `scp`s the compose files, logs the box into
   GHCR with the run's **ephemeral** `GITHUB_TOKEN` (nothing long-lived on the server),
   `compose pull` → run `migrate` to completion → **rolling replace** of api, worker,
   web via [`docker rollout`](https://github.com/wowu/docker-rollout) (start the new
   container next to the old, wait for its healthcheck, then retire the old — zero
   downtime; traffic drains over compose DNS: cloudflared→`web:80`, nginx→`api:3000`
   re-resolved per request) → `docker logout`. If a new container never goes healthy
   the rollout fails the run **with the previous release still serving**. Consequence:
   migrations must be backward-compatible (expand/contract) — the old api/worker run
   against the new schema during the overlap. When the `sandbox` profile is active on the box
   (`$COMPOSE config --services` names `sandbox-runner`) the deploy additionally pulls the four
   sandbox images **by digest** — compose can't, since the runner launches them through the host
   Docker rather than as services — and starts the runner with `SANDBOX_REQUIRE_DIGEST=1`, which
   makes it refuse to boot on a mutable tag. A box without the profile pulls none of them.
4. **Rollback / redeploy:** run *Deploy* manually with any older tag as the ref — it
   pulls the existing images for that tag, byte-identical to what ran before.
   Releases created by hand in the GitHub UI also trigger a deploy (`release: published`).

Set two repo secrets (*Settings → Secrets and variables → Actions*):
- `DEPLOY_SSH_KEY` — the **private** half of the deploy keypair (`deploy_key`).
- `DEPLOY_HOST` — `terraform output -raw server_ipv4`.

And, if you use Firebase login / browser Sentry, set these as repo **secrets** too
(*Secrets* tab, same page). They are publishable client-side values inlined into the
web bundle at image build, so nothing is actually being kept secret — but the workflow
reads them as `${{ secrets.VITE_* }}`, so a value put on the *Variables* tab is NOT
read: `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`,
`VITE_FIREBASE_PROJECT_ID`, `VITE_FIREBASE_STORAGE_BUCKET`,
`VITE_FIREBASE_MESSAGING_SENDER_ID`, `VITE_FIREBASE_APP_ID`, `VITE_SENTRY_DSN`,
`VITE_SENTRY_TRACES_SAMPLE_RATE`. Unset `VITE_SENTRY_DSN` ⇒ browser Sentry is off
entirely. With the DSN set, an unset **rate** now means "use the built-in default"
(#1034): tracing samples 10% of transactions and a session replay is kept whenever an
error occurs — set the rate secrets explicitly (e.g. to `0`) to change either.
(The server `.env` copies of `VITE_*` are ignored in this variant — the web image is
already built when it reaches the box.)

**A Sentry project per app (optional).** `SENTRY_DSN` is the shared backend fallback; set
the repo secrets `SENTRY_DSN_API` and/or `SENTRY_DSN_WORKER` to point an app at its own
Sentry project instead — separate issue streams, alert rules, ownership and quota, so a
noisy worker can't bury an API regression. `SENTRY_DSN_WORKER` covers **both** worker pools
(`worker` and `worker-heavy`), which run identical code. The SPA already reports separately
via the build-time `VITE_SENTRY_DSN`. Any of these unset ⇒ that app falls back to
`SENTRY_DSN`, and the `component` tag keeps a single shared project filterable.

The **sandbox-runner is deliberately not instrumented**: it is the one container with Docker
access (host-root-adjacent) and is kept dependency-minimal on purpose
(`docs/design/CLAUDE-CODE-NODE.md` §8b.1) — its image is built standalone with plain `npm
install`, so it cannot take a `workspace:*` dependency, and wiring a bare SDK there would add
an un-scrubbed egress path in the process that handles tenant keys per request. Its failures
are visible as **worker** activity failures. `SENTRY_DSN_SANDBOX_RUNNER` is already the name
`initSentry` would read if that changes.

It deploys via a GitHub-**hosted** runner (prod credentials stay off the shared
self-hosted CI runner), so `ssh_allowed_cidrs` must keep port 22 reachable from GitHub
(the default `0.0.0.0/0` is fine — SSH is key-only). To require a human click before
each deploy, add a *required reviewers* rule to the auto-created `production` environment.

### Cut-over & gotchas

- **One tunnel, one origin.** The Terraform manages a single tunnel — if `cloudflared`
  is still running on the old box when the Hetzner one connects, Cloudflare will
  round-robin between BOTH origins (two different DBs!). Stop the old `cloudflared`
  before/at first boot of the new box. For a side-by-side trial instead, change
  `hostname` (e.g. `hetzner.naar-y.com`) + `tunnel_name` in a separate state/workspace.
- **Migrating existing data:** `pg_dump` from the old box → `psql "<MIGRATE_DATABASE_URL>"`
  (direct endpoint) before cut-over.
- **Secrets in state:** the tfstate now also holds the Neon password, `ENCRYPTION_KEY`,
  and DB URLs — the GCS state bucket must stay private + versioned. Back up
  `ENCRYPTION_KEY` separately; losing it invalidates stored tenant credentials.
- **Neon autosuspend:** the default scale-to-zero adds a ~½s cold start after idle
  periods. Fine to start; raise the suspend timeout in Neon if it bothers you.
- **Box provisioned before the GHCR switch?** It may still carry a git checkout in
  `/opt/naary` (with a PAT in `.git/config`). The GHCR deploy works right over it, but
  clean up: revoke that PAT, then keep only the env file —
  `find /opt/naary -mindepth 1 -maxdepth 1 ! -name '.env' -exec rm -rf {} +`
  (the deploy re-ships the compose files every run).
- **GHCR visibility:** the first push creates the packages **private** and linked to
  the repo, which is what lets the workflow's `GITHUB_TOKEN` pull them — no action needed.
  This applies to the four `naary-*-sandbox` packages too; if a sandbox box ever fails the
  deploy at `failed to pull …`, check that package's *Manage Actions access* lists this repo
  (`naary-sandbox-runner` is the working precedent to compare against).
- **Disk with the sandbox profile on:** the four sandbox images add ~1.7GiB (they share the
  231MB `node:24-bookworm-slim` base, stored once), so the pre-pull free-space guard rises
  from 12GiB to 14GiB — but only on boxes running the profile. They carry a
  `com.naary.sandbox=1` label and are **excluded** from the general
  `docker image prune -af --filter until=…`: nothing references them between `--rm` runs, so
  the prune would otherwise delete them every deploy and re-download 1.7GiB. Superseded ones
  are removed by a targeted sweep after a successful rollout.
- **Costs:** Hetzner `cx33` ~€7/mo · Neon free tier (or Launch $19/mo) · Temporal Cloud
  (usage-based) · Cloudflare free · GHCR free for private packages within GitHub's
  storage quota.

---

## Switching to Temporal Cloud later
Self-hosting Temporal is the one piece where *managed* pays off (HA, backups, upgrades). To switch:
1. Create a Temporal Cloud namespace + API key.
2. In `.env` set `TEMPORAL_ADDRESS`, `TEMPORAL_NAMESPACE`, `TEMPORAL_API_KEY` (see `.env.prod.example`).
3. Remove the `temporal` service from the run (or just stop relying on it) and `up -d` again.
No code changes — the app reads the connection purely from env (`@naary/temporal-config`).
