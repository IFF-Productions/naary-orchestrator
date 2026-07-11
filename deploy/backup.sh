#!/usr/bin/env bash
# Nightly backup for the self-hosted stack: pg_dump (the app DB) + the Temporal
# dev-server SQLite file. Keeps the last N locally; optionally ships them off-box
# with rclone (set BACKUP_RCLONE_REMOTE in .env, e.g. r2:naary-backups).
#
# On the server:
#   chmod +x deploy/backup.sh
#   crontab -e   →   15 3 * * *  cd /path/to/repo && ./deploy/backup.sh >> /var/log/naary-backup.log 2>&1
#
# Data lives ONLY on this box — without this you WILL lose it on a disk failure.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

# Load .env so we get POSTGRES_* and the optional BACKUP_RCLONE_REMOTE.
set -a; [ -f .env ] && . ./.env; set +a

BACKUP_DIR="${BACKUP_DIR:-$REPO_DIR/backups}"
KEEP="${BACKUP_KEEP:-7}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$BACKUP_DIR"

DB="${POSTGRES_DB:-naary_orchestrator}"
USER="${POSTGRES_USER:-naary}"

echo "[$(date -u)] pg_dump $DB → $BACKUP_DIR/pg_${STAMP}.sql.gz"
docker compose exec -T postgres pg_dump -U "$USER" -d "$DB" \
  | gzip > "$BACKUP_DIR/pg_${STAMP}.sql.gz"

# Temporal dev-server state (SQLite). Skip silently if not present (e.g. Temporal Cloud).
if docker compose exec -T temporal test -f /data/temporal.db 2>/dev/null; then
  echo "[$(date -u)] temporal.db → $BACKUP_DIR/temporal_${STAMP}.db"
  docker compose exec -T temporal cat /data/temporal.db > "$BACKUP_DIR/temporal_${STAMP}.db"
fi

# Prune local copies beyond KEEP (per prefix).
for prefix in pg temporal; do
  ls -1t "$BACKUP_DIR/${prefix}_"* 2>/dev/null | tail -n +"$((KEEP + 1))" | xargs -r rm -f
done

# Optional off-box copy (rclone must be installed + the remote configured).
if [ -n "${BACKUP_RCLONE_REMOTE:-}" ] && command -v rclone >/dev/null 2>&1; then
  echo "[$(date -u)] rclone → $BACKUP_RCLONE_REMOTE"
  rclone copy "$BACKUP_DIR/pg_${STAMP}.sql.gz" "$BACKUP_RCLONE_REMOTE/"
  [ -f "$BACKUP_DIR/temporal_${STAMP}.db" ] && rclone copy "$BACKUP_DIR/temporal_${STAMP}.db" "$BACKUP_RCLONE_REMOTE/"
fi

echo "[$(date -u)] backup done"
