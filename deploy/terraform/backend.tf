# Remote Terraform state in your Firebase Storage bucket (a GCS bucket under the hood),
# so state is shared/durable instead of a local file. The `gcs` backend also LOCKS state
# natively (no separate lock table needed) — see deploy/README.md.
#
# Setup:
#   1. Confirm the bucket name in Firebase console → Storage. It's either
#      "<project-id>.appspot.com" or (newer projects) "<project-id>.firebasestorage.app".
#   2. Auth as a service account with roles/storage.objectAdmin on the bucket:
#        export GOOGLE_APPLICATION_CREDENTIALS=/path/to/sa-key.json
#      (Terraform uses the GCS *API* → governed by IAM, NOT Firebase Security Rules.)
#   3. Migrate the existing local state up to the bucket:
#        terraform init -migrate-state
#   4. Recommended: enable versioning for rollback:
#        gsutil versioning set on gs://<bucket>
#
# NOTE: tfstate holds secrets (the tunnel secret/token). Keep the bucket PRIVATE and the
# service account tightly scoped.
terraform {
  backend "gcs" {
    bucket = "naary-7b78f.firebasestorage.app" # ← verify/adjust to your actual Firebase Storage bucket
    prefix = "terraform/naary"
  }
}
