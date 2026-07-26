-- Hosted-form logo uploads: METADATA for images whose bytes live in object storage (S3).
-- EXPAND-only (one brand-new table, no change to an existing one), so a rolling deploy is safe in
-- both directions — an old api simply never touches it, and a new api with no rows serves no logo.
--
-- Bytes are NOT stored here: `objectRef` is an opaque @naary/storage reference (s3://bucket/key).
-- The row exists so ownership, content type and dedupe can be answered with one indexed lookup
-- instead of a bucket listing, and so a graph's logoAssetId resolves without S3 being reachable.

CREATE TABLE "FormAsset" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "objectRef" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FormAsset_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "FormAsset_tenantId_environmentId_idx"
    ON "FormAsset"("tenantId", "environmentId");

-- Content-addressed dedupe: re-uploading the same file reuses the existing row and object instead of
-- accumulating copies, which is also what makes the served id safe to cache immutably.
CREATE UNIQUE INDEX "FormAsset_tenantId_environmentId_kind_sha256_key"
    ON "FormAsset"("tenantId", "environmentId", "kind", "sha256");

-- RESTRICT (not CASCADE): an environment must not be deletable while a live public form still
-- references one of its logos — the form would start serving a broken image.
ALTER TABLE "FormAsset" ADD CONSTRAINT "FormAsset_environmentId_fkey"
    FOREIGN KEY ("environmentId") REFERENCES "Environment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
