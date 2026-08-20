#!/usr/bin/env bash
# Ship + start the data-box stack (Postgres + Temporal + Temporal UI) over SSH.
# Run from your machine, from anywhere in the repo:
#
#   ./deploy/data/deploy.sh root@$(terraform -chdir=deploy/terraform output -raw data_server_ipv4) [-i ssh_key]
#
# Idempotent: re-run to ship compose/backup changes and roll the stack (compose
# reconciles; postgres/temporal only restart if their config actually changed).
# Prereqs on the box: Docker + /opt/naary-data/.env — both staged by cloud-init
# (deploy/terraform/cloud-init-data.yaml.tftpl). For a hand-provisioned box, install
# Docker and write the .env first (terraform output -raw data_server_env).
set -euo pipefail

HOST="${1:?usage: deploy.sh user@host [extra ssh args…]}"
shift
SSH=(ssh "$@" -o StrictHostKeyChecking=accept-new "$HOST")

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "→ shipping compose + backup script to $HOST:/opt/naary-data"
tar czf - -C "$DIR" docker-compose.yml backup.sh \
  | "${SSH[@]}" "mkdir -p /opt/naary-data && tar xzf - -C /opt/naary-data"

"${SSH[@]}" bash -s <<'REMOTE'
set -euo pipefail
cd /opt/naary-data
[ -f .env ] || { echo "ERROR: /opt/naary-data/.env missing — cloud-init stages it; restore with: terraform -chdir=deploy/terraform output -raw data_server_env > /opt/naary-data/.env && chmod 600 .env" >&2; exit 1; }

docker compose pull -q
docker compose up -d --wait --wait-timeout 300

# Nightly backups (idempotent cron install).
chmod +x backup.sh
( crontab -l 2>/dev/null | grep -v 'naary-data/backup.sh' ; \
  echo '15 3 * * * cd /opt/naary-data && ./backup.sh >> /var/log/naary-backup.log 2>&1' ) | crontab -

echo "── status ─────────────────────────────────────────────"
docker compose ps
echo "── verify ─────────────────────────────────────────────"
docker compose exec -T postgres pg_isready -U "$(grep ^POSTGRES_USER .env | cut -d= -f2)"
docker compose exec -T postgres psql -U "$(grep ^POSTGRES_USER .env | cut -d= -f2)" -Atc "SELECT datname FROM pg_database WHERE datname IN ('naary_orchestrator','temporal','temporal_visibility') ORDER BY 1"
echo "temporal frontend: $(timeout 3 bash -c '</dev/tcp/127.0.0.1/7233' && echo OK || echo UNREACHABLE)"
REMOTE

echo "✓ data stack deployed. Temporal UI: ssh -L 8233:localhost:8233 $HOST → http://localhost:8233"
