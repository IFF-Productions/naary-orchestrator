terraform {
  required_version = ">= 1.5"

  required_providers {
    # NOTE: the Cloudflare provider renames tunnel/DNS resources between majors.
    # This config targets v4.40.x. If you use v5, see deploy/README.md → "Provider
    # version note" for the renamed resources (…_cloudflared, cloudflare_dns_record).
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 4.40"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}
