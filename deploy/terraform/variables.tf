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

# ── Hetzner (hetzner.tf) ───────────────────────────────────────────────────────────────

variable "hcloud_token" {
  type        = string
  sensitive   = true
  description = "Hetzner Cloud API token (console → your project → Security → API tokens → Read & Write)."
}

variable "server_name" {
  type        = string
  default     = "naary-prod"
  description = "Name of the Hetzner server (also prefixes the SSH key + firewall names)."
}

variable "server_type" {
  type        = string
  default     = "cx33"
  description = "Hetzner server type. cx33 = 4 vCPU / 8 GB (Intel shared, EU-only) matches the stack's ~8 GB guidance. Alternatives: cax21 (ARM, cheaper — images build on-box so arch doesn't matter), cpx32 (AMD, also in sin), cpx31 (AMD, incl. US locations). Catalog names rotate generations (cx32→cx33) — on 'server type not found', list current ones: curl -H \"Authorization: Bearer $TOKEN\" https://api.hetzner.cloud/v1/server_types"
}

variable "server_location" {
  type        = string
  default     = "nbg1"
  description = "Hetzner location (nbg1/fsn1/hel1 EU; ash/hil US — cx types are EU-only). Keep near the Neon region for DB latency."
}

variable "ssh_public_key" {
  type        = string
  description = "Your SSH public key CONTENT (e.g. contents of ~/.ssh/id_ed25519.pub) — the only way into the box."
}

variable "deploy_ssh_public_key" {
  type        = string
  default     = ""
  description = "Public half of a DEDICATED deploy keypair for GitHub Actions (ssh-keygen -t ed25519 -f deploy_key). Private half → repo secret DEPLOY_SSH_KEY. Empty ⇒ no CI/CD key. Set BEFORE the first apply — hcloud injects keys at create time."
}

variable "ssh_allowed_cidrs" {
  type        = list(string)
  default     = ["0.0.0.0/0", "::/0"]
  description = "CIDRs allowed to reach SSH (the ONLY open inbound port). Tighten to your IP if it's static."
}

variable "repo_url" {
  type        = string
  default     = ""
  sensitive   = true # may embed a token for a private repo
  description = "Git URL cloud-init clones to /opt/naary. For a private GitHub repo use https://<fine-grained-PAT>@github.com/<owner>/<repo>.git (marked sensitive for that reason). NOTE: the token persists in /opt/naary/.git/config on the server — deliberate (each CD deploy runs `git fetch`), but it means box compromise = token compromise, so scope the PAT to READ-ONLY Contents on this ONE repo and give it an expiry. Empty ⇒ skip; you clone manually after boot."
}

variable "temporal_address" {
  type        = string
  default     = ""
  description = "Temporal Cloud gRPC endpoint (e.g. eu-central-1.aws.api.temporal.io:7233). Empty ⇒ cloud-init stages .env but does NOT start the stack (you fill it in and `up` manually)."
}

variable "temporal_namespace" {
  type        = string
  default     = ""
  description = "Fully-qualified Temporal Cloud namespace (<namespace>.<account>)."
}

variable "temporal_api_key" {
  type        = string
  default     = ""
  sensitive   = true
  description = "Temporal Cloud API key (Settings → API Keys)."
}

# ── Neon (neon.tf) ─────────────────────────────────────────────────────────────────────

variable "neon_api_key" {
  type        = string
  sensitive   = true
  description = "Neon API key (console → Account settings → API keys)."
}

variable "neon_project_name" {
  type        = string
  default     = "naary"
  description = "Name of the Neon project."
}

variable "neon_region" {
  type        = string
  default     = "aws-eu-central-1"
  description = "Neon region id (aws-eu-central-1 = Frankfurt — pairs with Hetzner nbg1/fsn1)."
}
