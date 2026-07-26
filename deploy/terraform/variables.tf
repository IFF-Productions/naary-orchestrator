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

variable "temporal_address" {
  type        = string
  default     = ""
  description = "Temporal Cloud gRPC endpoint (e.g. eu-central-1.aws.api.temporal.io:7233) — lands in the generated /opt/naary/.env. Empty ⇒ fill it in on the server before the first deploy (api/worker can't run without it)."
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

# ── Object storage (s3.tf) ─────────────────────────────────────────────────────────────

variable "create_s3" {
  type        = bool
  default     = true
  description = "Create the S3 bucket + IAM user for object storage. Set false if you already manage a bucket elsewhere (then set STORAGE_PROVIDER/S3_BUCKET/credentials in the server .env by hand). Required for hosted-form LOGO uploads: without object storage those fail closed with a 503, deliberately, since a logo held in one API process's memory would vanish on the next rolling deploy."
}

variable "aws_region" {
  type        = string
  default     = "eu-central-1"
  description = "AWS region for the bucket. Pick one near the Hetzner box (eu-central-1 for Falkenstein/Nuremberg) — every logo view and claim-check read crosses this link."
}

variable "s3_bucket_name" {
  type        = string
  default     = null
  description = "Globally-unique bucket name, e.g. \"naary-prod-assets\". S3 bucket names are shared across ALL AWS accounts, so a generic name will collide."
}

variable "s3_iam_user_name" {
  type        = string
  default     = "naary-object-storage"
  description = "Name of the dedicated IAM user whose access key the API + worker use. No instance role exists on a Hetzner VPS, so a long-lived key is the only option — hence the two-action least-privilege policy in s3.tf."
}

variable "s3_versioning" {
  type        = bool
  default     = true
  description = "Keep noncurrent object versions (expired after s3_noncurrent_version_retention_days). A safety net for form logos, which a saved workflow references and a public page renders."
}

variable "s3_claim_check_retention_days" {
  type        = number
  default     = 30
  description = "Days to keep claim-check payloads (items/ ctx/ sql/ http/) — large activity outputs offloaded so Temporal payloads stay under the ~2MB cap. Only needs to cover how far back run detail is worth inspecting; a missing one degrades gracefully (the UI shows an 'offloaded' marker). Form assets are NEVER expired."
}

variable "s3_noncurrent_version_retention_days" {
  type        = number
  default     = 30
  description = "Days to keep superseded versions of form assets before deletion."
}

variable "s3_kms_key_arn" {
  type        = string
  default     = null
  description = "Optional CMK ARN for SSE-KMS instead of the default SSE-S3 (AES256). Set this only if you need an audit trail on key use or a key you rotate yourself; the IAM policy then also grants kms:Decrypt/GenerateDataKey on it."
}

variable "s3_scope_to_prefixes" {
  type        = bool
  default     = false
  description = "Narrow the IAM policy to the specific key prefixes the app uses instead of all objects in the bucket. Only worth it if you SHARE this bucket with another workload — otherwise the bucket is the trust boundary, and a per-prefix policy breaks with a confusing AccessDenied the first time a new claim-check prefix is added in the worker."
}
