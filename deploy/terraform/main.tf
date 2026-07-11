provider "cloudflare" {
  api_token = var.cloudflare_api_token
}

# A 64-byte secret backing the tunnel. Cloudflare wants it base64-encoded.
resource "random_password" "tunnel_secret" {
  length  = 64
  special = false
}

# The named tunnel. `config_src = "cloudflare"` means the ingress rules are managed
# remotely (by the _config resource below), so the cloudflared container on your server
# only needs the token — no local config file.
resource "cloudflare_zero_trust_tunnel_cloudflared" "naary" {
  account_id = var.cloudflare_account_id
  name       = var.tunnel_name
  secret     = base64encode(random_password.tunnel_secret.result)
  config_src = "cloudflare"
}

# Ingress: <hostname> → the web container; a required catch-all 404 terminates the list.
# The web container's nginx serves the SPA and proxies /api → api:3000, so this single
# rule serves the whole app (UI, /api, hosted forms/chat, webhooks, oauth callback).
resource "cloudflare_zero_trust_tunnel_cloudflared_config" "naary" {
  account_id = var.cloudflare_account_id
  tunnel_id  = cloudflare_zero_trust_tunnel_cloudflared.naary.id

  config {
    ingress_rule {
      hostname = var.hostname
      service  = var.origin_service
    }
    ingress_rule {
      service = "http_status:404"
    }
  }
}

# Proxied CNAME → the tunnel. Cloudflare terminates TLS at the edge; the origin is never
# exposed and no A record / public IP is involved. Works behind NAT/CGNAT.
resource "cloudflare_record" "naary" {
  zone_id = var.cloudflare_zone_id
  name    = var.hostname
  type    = "CNAME"
  value   = "${cloudflare_zero_trust_tunnel_cloudflared.naary.id}.cfargotunnel.com"
  proxied = true
  comment = "naary-orchestrator via Cloudflare Tunnel (managed by Terraform)"

  # naar-y.com already has a record (Cloudflare adds one on domain onboarding).
  # We WANT the apex to serve the app, so let Terraform replace it with the tunnel
  # CNAME. This clobbers whatever's currently at this exact name — verify in the
  # dashboard first that it isn't something you need (MX/TXT for email are separate
  # record types and are NOT affected).
  allow_overwrite = true
}
