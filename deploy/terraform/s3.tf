# ── Object storage (S3) ─────────────────────────────────────────────────────────────────
#
# One bucket serves TWO workloads with very different lifetimes:
#
#   form-assets/…   hosted-form logos, uploaded by the API. Referenced by a saved workflow and
#                   rendered on a customer-facing page — must live as long as the workflow does.
#   items/ ctx/     claim-check payloads: large activity outputs the WORKER offloads so Temporal
#   sql/  http/     payloads stay under the ~2MB cap. Read back while a run is live or being
#                   inspected, then dead weight forever.
#
# That difference drives the lifecycle rules below: claim-checks expire, form assets never do.
# Deleting a logo out from under a live form would show a broken image on a public page (the asset
# route 404s a missing object rather than 500ing, which is the right failure but still a visible one).
#
# WHY AN ACCESS KEY AND NOT AN INSTANCE ROLE: the app runs on a Hetzner VPS, not EC2, so there is no
# instance profile to assume. A long-lived key for a dedicated, least-privilege IAM user is the
# available option — hence the tight policy and the `naary_s3_*` outputs that feed the server's .env.

# Credentials come from your normal AWS chain (AWS_PROFILE, AWS_ACCESS_KEY_ID/SECRET, SSO) — the
# operator's own admin credentials, used only to CREATE these resources. They are not the credentials
# the app runs with: that's the dedicated least-privilege key at the bottom of this file.
provider "aws" {
  region = var.aws_region
}

locals {
  s3_count = var.create_s3 ? 1 : 0
  # Prefixes whose objects are transient. Kept as a local (not a variable) because they're determined
  # by the worker's claim-check call sites, not by an operator's preference — see items.ts/sql.ts/http.ts.
  # `resume/` holds a FAILED run's whole ctx so the run can be resumed at the node that died
  # (docs/design/RESUME-FROM-FAILED-NODE.md). Same class as the other prefixes — transient run
  # content, referenced from Postgres by claim-check only — so it inherits the same expiry. NB the
  # consequence is real and documented: once it expires, that run can no longer be resumed (the API
  # returns a 409 saying so), which is why the retention window is the one knob that matters here.
  claim_check_prefixes = ["items/", "ctx/", "sql/", "http/", "resume/"]
}

resource "aws_s3_bucket" "naary" {
  count  = local.s3_count
  bucket = var.s3_bucket_name

  tags = {
    Name    = "naary"
    Purpose = "form-assets + claim-check payloads"
  }

  # `create_s3` defaults to true while `s3_bucket_name` has no default, so a first apply with an
  # unedited tfvars would otherwise reach AWS with a null bucket name and fail on a provider error that
  # never mentions the variable. A precondition (not a cross-variable `validation` block, which needs
  # Terraform 1.9 while this module supports >= 1.5) fails at PLAN time with the fix in the message.
  lifecycle {
    precondition {
      condition     = var.s3_bucket_name != null && var.s3_bucket_name != ""
      error_message = "s3_bucket_name is required when create_s3 is true. Set it in terraform.tfvars (names are globally unique across all AWS accounts — e.g. naary-prod-assets), or set create_s3 = false to manage object storage yourself."
    }
  }
}

# Block every form of public access. Nothing is ever served to a browser DIRECTLY from S3: the API
# reads objects and streams them from our own origin, which is what lets it apply `nosniff` and a
# `default-src 'none'; sandbox` CSP to tenant-uploaded bytes. A public bucket would route around all
# of that, so this is a hard requirement, not hardening.
resource "aws_s3_bucket_public_access_block" "naary" {
  count                   = local.s3_count
  bucket                  = aws_s3_bucket.naary[0].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Disable ACLs entirely (the modern default). With ownership enforced, access is governed only by the
# IAM policy below — one mechanism to reason about instead of two overlapping ones.
resource "aws_s3_bucket_ownership_controls" "naary" {
  count  = local.s3_count
  bucket = aws_s3_bucket.naary[0].id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "naary" {
  count  = local.s3_count
  bucket = aws_s3_bucket.naary[0].id
  rule {
    apply_server_side_encryption_by_default {
      # SSE-S3 (AES256) by default: no key to manage and no per-request KMS cost. Set
      # `s3_kms_key_arn` for SSE-KMS if you need an audit trail on key use or a CMK you rotate —
      # the IAM policy then also needs kms:Decrypt/GenerateDataKey (see the note in deploy/README.md).
      sse_algorithm     = var.s3_kms_key_arn == null ? "AES256" : "aws:kms"
      kms_master_key_id = var.s3_kms_key_arn
    }
    # Cuts KMS request cost/throttling by reusing a data key per object prefix. No-op for SSE-S3.
    bucket_key_enabled = var.s3_kms_key_arn != null
  }
}

# Versioning is a safety net for the DURABLE half: a logo is content-addressed, so a re-upload writes
# the same key with identical bytes and never clobbers anything — but an operator with console access
# can still delete one, and a form referencing it would break. Noncurrent versions are expired below so
# this doesn't become an unbounded bill.
resource "aws_s3_bucket_versioning" "naary" {
  count  = local.s3_count
  bucket = aws_s3_bucket.naary[0].id
  versioning_configuration {
    status = var.s3_versioning ? "Enabled" : "Suspended"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "naary" {
  count  = local.s3_count
  bucket = aws_s3_bucket.naary[0].id
  # Versioning must exist before rules referencing noncurrent versions are accepted.
  depends_on = [aws_s3_bucket_versioning.naary]

  # Claim-check payloads: transient by construction. They're read while a run is live or while someone
  # inspects it, so the retention window only needs to cover how far back run detail is useful. A
  # resolved-but-missing claim-check degrades gracefully (the API falls back to the raw ctx and the UI
  # shows an "offloaded" marker), so expiry is safe here in a way it is NOT for form assets.
  dynamic "rule" {
    for_each = local.claim_check_prefixes
    content {
      id     = "expire-claim-checks-${trimsuffix(rule.value, "/")}"
      status = "Enabled"
      filter {
        prefix = rule.value
      }
      expiration {
        days = var.s3_claim_check_retention_days
      }
      noncurrent_version_expiration {
        noncurrent_days = 1
      }
    }
  }

  # form-assets/ deliberately has NO expiration rule. A logo is referenced by a saved workflow and
  # rendered on a public page; expiring it would break that page silently from the tenant's point of
  # view. Only superseded VERSIONS are cleaned up.
  rule {
    id     = "expire-noncurrent-form-assets"
    status = "Enabled"
    filter {
      prefix = "form-assets/"
    }
    noncurrent_version_expiration {
      noncurrent_days = var.s3_noncurrent_version_retention_days
    }
  }

  # A failed multipart upload leaves parts that are billed but invisible in the object listing —
  # the classic silent S3 cost leak. Applies bucket-wide.
  rule {
    id     = "abort-incomplete-multipart"
    status = "Enabled"
    filter {}
    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

# ── IAM: one dedicated user for the app ─────────────────────────────────────────────────
#
# Scoped to exactly the two actions the code performs. `S3ObjectStore` only ever calls PutObject and
# GetObject — it never lists, never deletes, never touches bucket configuration — so the policy says
# only that. A leaked key therefore cannot enumerate the bucket, delete a tenant's logo, or turn off
# encryption; the worst it can do is read or overwrite an object whose full key the holder already
# knows (and keys carry a sha256, so they aren't guessable).
#
# Resources are scoped to this bucket's objects rather than to individual prefixes. The bucket is
# dedicated to this application, so the bucket IS the trust boundary — and a per-prefix list would
# break with a confusing AccessDenied the first time a new claim-check prefix is added in the worker.
# Set `s3_scope_to_prefixes = true` if you must share the bucket with another workload.

resource "aws_iam_user" "naary" {
  count = local.s3_count
  name  = var.s3_iam_user_name
  tags = {
    Name    = "naary"
    Purpose = "naary API + worker object storage"
  }
}

data "aws_iam_policy_document" "naary_s3" {
  count = local.s3_count

  statement {
    sid    = "ReadWriteObjects"
    effect = "Allow"
    # Exactly what @naary/storage's S3ObjectStore calls. Adding DeleteObject would let a leaked key
    # destroy tenant logos; nothing in the app needs it (lifecycle rules do the deleting).
    actions = ["s3:GetObject", "s3:PutObject"]
    resources = var.s3_scope_to_prefixes ? [
      for p in concat(["form-assets/"], local.claim_check_prefixes) :
      "${aws_s3_bucket.naary[0].arn}/${p}*"
    ] : ["${aws_s3_bucket.naary[0].arn}/*"]
  }

  # SSE-KMS needs the data-key grants too, or every Put/Get fails with AccessDenied on the KEY rather
  # than the object — an error that reads as a bucket-permission problem and sends you the wrong way.
  dynamic "statement" {
    for_each = var.s3_kms_key_arn == null ? [] : [var.s3_kms_key_arn]
    content {
      sid       = "UseBucketKmsKey"
      effect    = "Allow"
      actions   = ["kms:Decrypt", "kms:GenerateDataKey"]
      resources = [statement.value]
    }
  }
}

resource "aws_iam_user_policy" "naary_s3" {
  count  = local.s3_count
  name   = "naary-object-storage"
  user   = aws_iam_user.naary[0].name
  policy = data.aws_iam_policy_document.naary_s3[0].json
}

# The long-lived key the VPS uses. There is no instance role to borrow on Hetzner, so this is the
# credential — rotate it by tainting this resource (`terraform taint aws_iam_access_key.naary[0]`),
# re-applying, and updating the server's .env. The secret lands in TERRAFORM STATE, so keep state
# private (deploy/.gitignore already excludes *.tfstate).
resource "aws_iam_access_key" "naary" {
  count = local.s3_count
  user  = aws_iam_user.naary[0].name
}
