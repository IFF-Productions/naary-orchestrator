#!/usr/bin/env bash
# Nightly backup for the DATA box: pg_dump of the app DB + Temporal's two DBs.
# Keeps the last N locally; optionally ships them off-box with rclone
# (set BACKUP_RCLONE_REMOTE in /opt/naary-data/.env, e.g. r2:naary-backups).
#
# Installed by deploy/data/deploy.sh as a root cron entry:
#   15 3 * * *  cd /opt/naary-data && ./backup.sh >> /var/log/naary-backup.log 2>&1
#
# Data lives ONLY on this box — without off-box copies you WILL lose it on a disk
# failure. NB the temporal + temporal_visibility dumps are each internally consistent
# but not mutually atomic; good enough for disaster recovery of a small cluster.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

set -a; [ -f .env ] && . ./.env; set +a

BACKUP_DIR="${BACKUP_DIR:-$PWD/backups}"
KEEP="${BACKUP_KEEP:-7}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$BACKUP_DIR"

USER="${POSTGRES_USER:-naary}"

for db in "${POSTGRES_DB:-naary_orchestrator}" temporal temporal_visibility; do
  echo "[$(date -u)] pg_dump $db → $BACKUP_DIR/${db}_${STAMP}.sql.gz"
  docker compose exec -T postgres pg_dump -U "$USER" -d "$db" \
    | gzip > "$BACKUP_DIR/${db}_${STAMP}.sql.gz"
done

# Prune local copies beyond KEEP (per database).
for prefix in "${POSTGRES_DB:-naary_orchestrator}" temporal temporal_visibility; do
  ls -1t "$BACKUP_DIR/${prefix}_"* 2>/dev/null | tail -n +"$((KEEP + 1))" | xargs -r rm -f
done

# Optional off-box copy (rclone must be installed + the remote configured).
if [ -n "${BACKUP_RCLONE_REMOTE:-}" ] && command -v rclone >/dev/null 2>&1; then
  echo "[$(date -u)] rclone → $BACKUP_RCLONE_REMOTE"
  for db in "${POSTGRES_DB:-naary_orchestrator}" temporal temporal_visibility; do
    rclone copy "$BACKUP_DIR/${db}_${STAMP}.sql.gz" "$BACKUP_RCLONE_REMOTE/"
  done
fi

echo "[$(date -u)] backup done"
