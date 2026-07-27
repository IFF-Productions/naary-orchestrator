/**
 * Configuration for `@naary/storage`. See docs/design/CONFIG-CENTRALIZATION.md (slice 3).
 *
 * Note what is NOT here: AWS credentials. The SDK reads AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY or
 * an instance role through its own chain, so this package never handles them — and an accessor
 * would only create a place for them to be logged.
 */

/** Which backend. Anything but "s3" ⇒ the in-process MemoryObjectStore, which is fine for dev and
 *  tests but is NOT durable and is invisible to any other process. */
export function storageProvider(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return env.STORAGE_PROVIDER;
}

/** Target bucket. Required when STORAGE_PROVIDER=s3 — the caller throws without it, because a
 *  silent fallback to memory would look like working object storage until a restart lost it. */
export function s3Bucket(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return env.S3_BUCKET;
}

/** Custom endpoint for an S3-compatible provider (R2/B2/MinIO). Unset ⇒ real AWS S3. */
export function s3Endpoint(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return env.S3_ENDPOINT?.trim() || undefined;
}

/**
 * Region, or undefined to let the AWS SDK resolve it (AWS_REGION → AWS_DEFAULT_REGION →
 * ~/.aws/config → instance profile). Deliberately NOT validated: hard-failing on an unset
 * AWS_REGION would reject deployments that legitimately configure it another way.
 *
 * The one case worth helping is an S3-compatible endpoint, which has no meaningful region while
 * the SDK still demands one — those providers document "auto", so defaulting it there turns a
 * confusing SDK error into a working client. Hence the endpoint argument.
 */
export function s3Region(
  hasEndpoint: boolean,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return env.AWS_REGION?.trim() || (hasEndpoint ? "auto" : undefined);
}
