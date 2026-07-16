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
