# The token cloudflared needs. SENSITIVE — do not paste anywhere public.
# Retrieve it after `apply` with:  terraform output -raw tunnel_token
# then put it in the SERVER's .env as CLOUDFLARE_TUNNEL_TOKEN=...
output "tunnel_token" {
  value       = cloudflare_zero_trust_tunnel_cloudflared.naary.tunnel_token
  sensitive   = true
  description = "Run: terraform output -raw tunnel_token  → CLOUDFLARE_TUNNEL_TOKEN in the server .env"
}

output "tunnel_id" {
  value       = cloudflare_zero_trust_tunnel_cloudflared.naary.id
  description = "The tunnel UUID (visible in Zero Trust → Networks → Tunnels)."
}

output "hostname" {
  value       = var.hostname
  description = "The public URL the app will be reachable at (https)."
}

output "server_ipv4" {
  value       = hcloud_server.naary.ipv4_address
  description = "Public IPv4 of the Hetzner server (SSH only — the app itself arrives via the tunnel)."
}

output "ssh_command" {
  value       = "ssh root@${hcloud_server.naary.ipv4_address}"
  description = "How to reach the box. First boot: `cloud-init status --wait` then check /etc/motd."
}

output "neon_host" {
  value       = neon_project.naary.database_host
  description = "Neon direct endpoint host (the pooled host is the same with a -pooler suffix)."
}

# SENSITIVE — the full .env cloud-init writes to the server (includes DB URLs,
# ENCRYPTION_KEY, tunnel token). Retrieve with: terraform output -raw server_env
# Save ENCRYPTION_KEY in a password manager — losing it invalidates stored tenant creds.
output "server_env" {
  value       = local.server_env
  sensitive   = true
  description = "The generated server .env — for backup or a manual (non-cloud-init) deploy."
}

# ── Object storage (s3.tf) ─────────────────────────────────────────────────────────────
# These four feed the SERVER's .env. Copy them in after `apply`:
#
#   STORAGE_PROVIDER=s3
#   S3_BUCKET=$(terraform output -raw s3_bucket)
#   AWS_REGION=$(terraform output -raw s3_region)
#   AWS_ACCESS_KEY_ID=$(terraform output -raw s3_access_key_id)
#   AWS_SECRET_ACCESS_KEY=$(terraform output -raw s3_secret_access_key)
#
# Without them, hosted-form logo uploads fail closed with a 503 (by design — see s3.tf).

output "s3_bucket" {
  value       = var.create_s3 ? aws_s3_bucket.naary[0].bucket : null
  description = "Bucket name → S3_BUCKET in the server .env."
}

output "s3_region" {
  value       = var.create_s3 ? var.aws_region : null
  description = "Bucket region → AWS_REGION in the server .env."
}

output "s3_access_key_id" {
  value       = var.create_s3 ? aws_iam_access_key.naary[0].id : null
  description = "Run: terraform output -raw s3_access_key_id  → AWS_ACCESS_KEY_ID in the server .env"
}

# SENSITIVE. Also present in terraform state, so keep state private (deploy/.gitignore excludes
# *.tfstate). Rotate with: terraform taint aws_iam_access_key.naary[0] && terraform apply
output "s3_secret_access_key" {
  value       = var.create_s3 ? aws_iam_access_key.naary[0].secret : null
  sensitive   = true
  description = "Run: terraform output -raw s3_secret_access_key  → AWS_SECRET_ACCESS_KEY in the server .env"
}
