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

## What's here
| File | Purpose |
|---|---|
| `terraform/` | Cloudflare tunnel + ingress + DNS record (the IaC part). Outputs the tunnel token. |
| `docker-compose.prod.yml` | Overlay on the repo's base compose: closes all ports, adds `cloudflared`. |
| `.env.prod.example` | Template for the server `.env` (copy to repo-root `.env`). |
| `backup.sh` | Nightly `pg_dump` + Temporal DB → local (+ optional rclone off-box). |

## Prerequisites
- **A Linux server** with Docker + Docker Compose v2 (≥ 2.24 for the `!override` in the overlay). ~8 GB RAM recommended (Postgres + Temporal + 3 Node services). x86 or ARM — images build on-box.
- **`naar-y.com` on Cloudflare** (nameservers → Cloudflare). ✅ You have this.
- **Terraform ≥ 1.5** on your laptop.
- A **Cloudflare API token** (Account → *Cloudflare Tunnel: Edit* + Zone → *DNS: Edit* on `naar-y.com`), your **Account ID** and the **Zone ID** (both in the dashboard sidebar).

---

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

## Switching to Temporal Cloud later
Self-hosting Temporal is the one piece where *managed* pays off (HA, backups, upgrades). To switch:
1. Create a Temporal Cloud namespace + API key.
2. In `.env` set `TEMPORAL_ADDRESS`, `TEMPORAL_NAMESPACE`, `TEMPORAL_API_KEY` (see `.env.prod.example`).
3. Remove the `temporal` service from the run (or just stop relying on it) and `up -d` again.
No code changes — the app reads the connection purely from env (`@naary/temporal-config`).
