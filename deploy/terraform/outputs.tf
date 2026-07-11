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
