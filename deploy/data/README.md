# Data box — Postgres + self-hosted Temporal

The dedicated Hetzner server (`naary-data`, `deploy/terraform/data-plane.tf`) that holds
the prod **app database** (pgvector Postgres) and the **self-hosted Temporal cluster**
(auto-setup, Postgres persistence) + Temporal UI. It replaced Neon (app DB) and
Temporal Cloud (durable execution) in Aug 2026 — a clean cut with a fresh database, by
decision; nothing was migrated.

- `docker-compose.yml` — the stack. Postgres + Temporal bind to the **private-network
  IP** (`BIND_IP` in `/opt/naary-data/.env`) + loopback; the UI binds loopback only.
- `deploy.sh` — ship + start/roll the stack over SSH (idempotent; also installs the
  backup cron). `./deploy/data/deploy.sh root@<data box ip>`
- `backup.sh` — nightly `pg_dump` of `naary_orchestrator`, `temporal`,
  `temporal_visibility` (runs ON the box via cron; `BACKUP_RCLONE_REMOTE=r2:naary-backups`
  in the box `.env` ships them to Cloudflare R2 — configured live 2026-08-24).

## Off-box backups (Cloudflare R2)

Remote `r2` in `/root/.config/rclone/rclone.conf` on the data box. Two hard-won gotchas
if it ever needs recreating:

- The bucket is **EU jurisdiction**, so the endpoint is
  `https://<account-id>.eu.r2.cloudflarestorage.com` — the standard (no `.eu`) endpoint
  answers `NoSuchBucket` for it.
- The token is **bucket-scoped**, which means it may not call `HeadBucket`/`CreateBucket`
  — without `no_check_bucket = true` in the rclone remote, every upload fails with
  `CreateBucket … AccessDenied` even though object read/write works fine.

Restore drill: `rclone copy r2:naary-backups/<dump>.sql.gz . && gunzip … && psql`.

## Ops quickies

```bash
# Temporal UI (never public):
ssh -L 8233:localhost:8233 root@<data box>   # → http://localhost:8233

# psql:
ssh root@<data box> "docker compose -f /opt/naary-data/docker-compose.yml --project-directory /opt/naary-data exec postgres psql -U naary naary_orchestrator"
```

## Cutover runbook (how the app box was switched — and how to re-do it)

1. `terraform apply` — creates the private network, the data server, and attaches the
   app box. On a LIVE app box check the new NIC got its 10.0.1.2 address (`ip a`;
   `dhclient <iface>` or reboot if not).
2. `./deploy/data/deploy.sh root@<data ip>` — stack up; verify the three databases and
   the Temporal frontend port in its output.
3. On the APP box, update `/opt/naary/.env`:
   `DATABASE_URL` / `MIGRATE_DATABASE_URL` → `postgresql://naary:<pw>@10.0.1.3:5432/naary_orchestrator?schema=public&connect_timeout=15`,
   `TEMPORAL_ADDRESS=10.0.1.3:7233`, `TEMPORAL_NAMESPACE=default`, delete
   `TEMPORAL_API_KEY`. (All emitted by `terraform output -raw server_env`.)
4. Run the Deploy workflow (any release). Migrations build the fresh schema; the
   rolling replace brings api/worker/web up against the data box.
5. Verify: `https://<hostname>/healthz` via the app, run a workflow end-to-end, watch
   it in the Temporal UI tunnel.
6. Decommission afterwards, deliberately: Temporal Cloud namespace (in-flight runs
   there are abandoned — clean cut), the Neon project (`terraform/neon.tf`), and the
   temporary hand-bought box if one exists.

## Upgrades

Bump the pinned `temporalio/auto-setup` / `temporalio/ui` tags ONE MINOR at a time
(Temporal's supported upgrade path), re-run `deploy.sh`, and let auto-setup migrate the
schemas. Postgres major upgrades = dump/restore (pg16 pinned).
