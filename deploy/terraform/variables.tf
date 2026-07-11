variable "cloudflare_api_token" {
  type        = string
  sensitive   = true
  description = "Cloudflare API token with Account:Cloudflare Tunnel:Edit + Zone:DNS:Edit on the naar-y.com zone. Set via TF_VAR_cloudflare_api_token or terraform.tfvars (kept local, gitignored)."
}

variable "cloudflare_account_id" {
  type        = string
  description = "Your Cloudflare account ID (dashboard → any domain → Overview, right sidebar)."
}

variable "cloudflare_zone_id" {
  type        = string
  description = "The Zone ID for naar-y.com (dashboard → naar-y.com → Overview, right sidebar)."
}

variable "hostname" {
  type        = string
  default     = "naar-y.com"
  description = "Public hostname the app is served on. Apex (naar-y.com) or a subdomain (app.naar-y.com)."
}

variable "tunnel_name" {
  type        = string
  default     = "naary"
  description = "Name of the Cloudflare Tunnel (shown in Zero Trust → Networks → Tunnels)."
}

variable "origin_service" {
  type        = string
  default     = "http://web:80"
  description = "Where cloudflared forwards traffic INSIDE the compose network. The web (nginx) container serves the SPA and proxies /api → api:3000, so one rule covers everything."
}
