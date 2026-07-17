# Neon — managed serverless Postgres for the prod stack (replaces the in-stack
# pgvector container; Neon ships the `vector` extension, so the RAG migrations work
# unchanged). Backups/PITR are Neon's problem, not backup.sh's.
#
# Provider: kislerdm/neon (the community provider Neon documents). API key from
# Neon console → Account settings → API keys.

provider "neon" {
  api_key = var.neon_api_key
}

resource "neon_project" "naary" {
  name       = var.neon_project_name
  region_id  = var.neon_region # aws-eu-central-1 (Frankfurt) pairs with Hetzner nbg1/fsn1
  pg_version = 16              # match the pgvector/pgvector:pg16 image the dev stack uses

  # Point-in-time-restore window. The provider defaults to 86400 (1 day), but Neon's
  # FREE plan caps it at 21600 (6 h) and rejects project creation above that (HTTP 400).
  # On a paid plan you can raise this (Launch allows up to 7 days).
  history_retention_seconds = 21600

  branch {
    name          = "main"
    database_name = "naary_orchestrator"
    role_name     = "naary"
  }
}

locals {
  neon_user = neon_project.naary.database_user
  neon_pass = urlencode(neon_project.naary.database_password)
  neon_db   = neon_project.naary.database_name

  # Neon's pooled (PgBouncer) endpoint is the direct host with a `-pooler` suffix on
  # the first label: ep-x-123.eu-central-1.aws.neon.tech → ep-x-123-pooler.eu-central-1…
  neon_host_direct = neon_project.naary.database_host
  neon_host_pooled = replace(neon_project.naary.database_host, "/^([^.]+)/", "$1-pooler")

  # api/worker (Prisma client) go through the pooler — pgbouncer=true makes Prisma
  # transaction-mode safe. Migrations need a DIRECT connection (advisory locks, DDL).
  neon_database_url_pooled = "postgresql://${local.neon_user}:${local.neon_pass}@${local.neon_host_pooled}/${local.neon_db}?sslmode=require&pgbouncer=true&connect_timeout=15"
  neon_database_url_direct = "postgresql://${local.neon_user}:${local.neon_pass}@${local.neon_host_direct}/${local.neon_db}?sslmode=require"
}
