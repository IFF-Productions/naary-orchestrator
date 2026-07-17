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
live off-box (Neon + Temporal Cloud), so the server is disposable.

```
Browser ──HTTPS──▶ Cloudflare edge ──tunnel──▶ Hetzner VPS (compose: cloudflared·web·api·worker·migrate)
                                                   │                        │
GitHub Actions ──SSH (deploy key)──────────────────┘              Neon (Postgres+pgvector)
                                                                  Temporal Cloud (durable exec)
```

### Provision (once, on your laptop)

1. Collect credentials into `terraform/terraform.tfvars` (see the example file):
   - **Hetzner** API token — console → your project → *Security → API tokens* (Read & Write).
   - **Neon** API key — console → *Account settings → API keys*.
   - **Cloudflare** token/IDs — as in Variant A above.
   - `ssh_public_key` — your personal key (admin access).
   - `deploy_ssh_public_key` — a **dedicated** CI keypair: `ssh-keygen -t ed25519 -f deploy_key -N ""`.
     Set it **before the first apply** (hcloud injects keys at create time only).
   - Optional but recommended for hands-off boot: `repo_url` (embed a read-only
     fine-grained PAT for a private repo) + the three `temporal_*` values (create the
     Temporal Cloud namespace + API key first).

2. Apply and grab outputs:
   ```bash
   cd deploy/terraform
   terraform init && terraform apply
   terraform output server_ipv4        # → GitHub secret DEPLOY_HOST
   terraform output -raw server_env    # the generated server .env — SAVE ENCRYPTION_KEY in a password manager
   ```

3. First boot: cloud-init installs Docker, writes `/opt/naary/.env`, and — if `repo_url`
   + `temporal_address` were set — clones the repo and starts the stack itself (first
   build ~5–10 min). Otherwise SSH in (`terraform output ssh_command`) and follow
   `/etc/motd`. Watch with `cloud-init status --wait`, then `docker compose ps`.

The compose invocation for this variant layers **both** overlays (order matters):
```bash
docker compose -f docker-compose.yml -f deploy/docker-compose.prod.yml -f deploy/docker-compose.neon.yml up -d --build
```
`DATABASE_URL` (api/worker) uses Neon's **pooled** endpoint with `pgbouncer=true`;
`MIGRATE_DATABASE_URL` (the `migrate` one-shot) uses the **direct** endpoint — Prisma
migrations need a real session (advisory locks + DDL), not PgBouncer.

### Releases & CD (GitHub Actions)

Deploys are **release-driven**, semver-tagged (`v0.0.1`):

1. **Cut a release:** *Actions → Release → Run workflow* → `version = 0.0.1` (or `v0.0.1`).
   `release.yml` bumps **every** workspace `package.json` (root + `apps/*` + `packages/*`)
   to that version, commits `chore(release): v0.0.1` to `main`, tags it, publishes a
   GitHub Release with generated notes — then chains straight into the deploy.
2. **Deploy** (`deploy.yml`): SSH → check out the tag (detached) → `compose up -d --build`
   with `VITE_APP_VERSION=<tag>` baked into the SPA → wait for the api healthcheck
   (fails the run, with logs, if it never goes healthy).
3. **Rollback / redeploy:** run *Deploy* manually with any older tag as the ref.
   Releases created by hand in the GitHub UI also trigger a deploy (`release: published`).

Set two repo secrets (*Settings → Secrets and variables → Actions*):
- `DEPLOY_SSH_KEY` — the **private** half of the deploy keypair (`deploy_key`).
- `DEPLOY_HOST` — `terraform output -raw server_ipv4`.

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
- **Costs:** Hetzner `cx33` ~€7/mo · Neon free tier (or Launch $19/mo) · Temporal Cloud
  (usage-based) · Cloudflare free.

---

## Switching to Temporal Cloud later
Self-hosting Temporal is the one piece where *managed* pays off (HA, backups, upgrades). To switch:
1. Create a Temporal Cloud namespace + API key.
2. In `.env` set `TEMPORAL_ADDRESS`, `TEMPORAL_NAMESPACE`, `TEMPORAL_API_KEY` (see `.env.prod.example`).
3. Remove the `temporal` service from the run (or just stop relying on it) and `up -d` again.
No code changes — the app reads the connection purely from env (`@naary/temporal-config`).
