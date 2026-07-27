import { describe, expect, it } from "vitest";
import { s3Endpoint, s3Region, storageProvider } from "../src/config";

/**
 * Slice 3 of docs/design/CONFIG-CENTRALIZATION.md. Region resolution is the one piece of judgment
 * in this package's config, so it's pinned rather than left to a comment.
 */
describe("S3 configuration", () => {
  /**
   * Unset region + real AWS ⇒ undefined, so the SDK runs its OWN chain (AWS_REGION →
   * AWS_DEFAULT_REGION → ~/.aws/config → instance profile). Hard-failing here would reject
   * deployments that legitimately configure it another way.
   *
   * Unset region + a custom endpoint ⇒ "auto". R2/B2/MinIO have no meaningful region but the SDK
   * still demands one, and they all document "auto" — so this turns a confusing SDK error into a
   * working client.
   */
  it("only invents a region for an S3-compatible endpoint", () => {
    expect(s3Region(false, {})).toBe(undefined);
    expect(s3Region(true, {})).toBe("auto");
    expect(s3Region(true, { AWS_REGION: "us-east-1" })).toBe("us-east-1");
    expect(s3Region(false, { AWS_REGION: " eu-west-2 " })).toBe("eu-west-2");
  });

  it("treats a blank endpoint as no endpoint", () => {
    expect(s3Endpoint({ S3_ENDPOINT: "  " })).toBe(undefined);
    expect(s3Endpoint({ S3_ENDPOINT: " https://r2.example " })).toBe(
      "https://r2.example",
    );
  });

  /** Anything but "s3" is the in-process memory store — durable for nobody, visible to no other
   *  process. The exact-match check is what keeps a typo from looking like object storage. */
  it("requires exactly s3 to select the durable backend", () => {
    expect(storageProvider({ STORAGE_PROVIDER: "s3" })).toBe("s3");
    expect(storageProvider({ STORAGE_PROVIDER: "S3" })).not.toBe("s3");
    expect(storageProvider({})).toBe(undefined);
  });
});
