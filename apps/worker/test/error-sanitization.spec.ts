import { ApplicationFailure } from "@temporalio/activity";
import { describe, expect, it } from "vitest";
import { toSanitizedRetryable } from "../src/temporal/activities";

// `ai` is ESM-only; a static import from this CJS-typed test trips TS7's node16 guard, so load it
// dynamically (vitest runs the test as ESM at runtime regardless).

// A non-key-shaped marker standing in for a leaked credential — the test asserts it
// never reaches the serialized failure (a real key would be sk-…/Bearer …).
const MARKER = "LEAKED-TENANT-CRED-MARKER";

describe("toSanitizedRetryable — no provider secret reaches Temporal history", () => {
  it("strips an APICallError's secret-bearing fields, keeps status, stays retryable", async () => {
    const { APICallError } = await import("ai");
    const apiErr = new APICallError({
      message: `Upstream error; sent token ${MARKER}`,
      url: "https://api.anthropic.com/v1/messages",
      requestBodyValues: { auth: MARKER },
      statusCode: 503,
      responseHeaders: { authorization: MARKER },
      responseBody: `{"key":"${MARKER}"}`,
      isRetryable: true,
    });

    const failure = toSanitizedRetryable(apiErr, "AGENT_TRANSIENT");

    // Fresh, retryable ApplicationFailure (Temporal still retries the transient call).
    expect(failure).toBeInstanceOf(ApplicationFailure);
    expect(failure.nonRetryable).toBe(false);
    expect(failure.type).toBe("AGENT_TRANSIENT");
    expect(failure.message).toContain("503");

    // Nothing emitted — message or the whole serialized failure (incl. any cause) —
    // may carry the credential or header material.
    const serialized = JSON.stringify(failure);
    for (const probe of [MARKER, "Bearer", "authorization", "x-api-key"]) {
      expect(failure.message).not.toContain(probe);
      expect(serialized).not.toContain(probe);
    }
  });

  it("keeps a generic transient error's message but drops its structured fields", () => {
    const netErr = Object.assign(new Error("network blip"), {
      requestHeaders: { authorization: MARKER },
    });

    const failure = toSanitizedRetryable(netErr, "MCP_TRANSIENT");

    expect(failure.nonRetryable).toBe(false);
    expect(failure.message).toBe("network blip"); // safe infra message preserved
    expect(JSON.stringify(failure)).not.toContain(MARKER);
  });
});
