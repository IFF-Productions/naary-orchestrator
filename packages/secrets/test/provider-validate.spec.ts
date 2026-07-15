import { afterEach, describe, expect, it, vi } from "vitest";

// Mock the model call so no network/key is needed; keep the REAL APICallError so
// `APICallError.isInstance` works against the errors we throw from the mock.
const generateTextMock = vi.fn();
vi.mock("ai", async (importActual) => {
  const actual = await importActual<typeof import("ai")>();
  return {
    ...actual,
    generateText: (...a: unknown[]) => generateTextMock(...a),
  };
});
vi.mock("@ai-sdk/anthropic", () => ({
  createAnthropic: () => () => ({}) as never, // model factory → dummy handle
}));
vi.mock("@ai-sdk/openai", () => ({
  createOpenAI: () => () => ({}) as never, // model factory → dummy handle
}));
vi.mock("@ai-sdk/google", () => ({
  createGoogleGenerativeAI: () => () => ({}) as never, // model factory → dummy handle
}));

import { APICallError } from "ai";
import {
  validateAnthropicKey,
  validateClaudeCodeKey,
  validateGoogleKey,
  validateOpenAiKey,
} from "../src/provider-validate";

function apiError(statusCode: number): APICallError {
  return new APICallError({
    message: "provider error",
    url: "https://api.anthropic.com/v1/messages",
    // A real APICallError can carry the Authorization header — assert we never leak it.
    requestBodyValues: {},
    statusCode,
    responseHeaders: { authorization: "Bearer sk-ant-secret" },
    responseBody: '{"error":{"type":"invalid_request_error"}}',
    isRetryable: statusCode >= 500,
  });
}

afterEach(() => generateTextMock.mockReset());

describe("validateAnthropicKey", () => {
  it("returns true when the ping succeeds", async () => {
    generateTextMock.mockResolvedValue({ text: "ok" });
    expect(await validateAnthropicKey("sk-ant-good")).toBe(true);
  });

  it.each([400, 401, 403, 404, 429])(
    "returns false (invalid, surfaced — not a 500) on a %i client error",
    async (status) => {
      generateTextMock.mockRejectedValue(apiError(status));
      expect(await validateAnthropicKey("sk-ant-bad")).toBe(false);
    },
  );

  it("rethrows a SANITIZED error on a 5xx transient (no secret-bearing fields)", async () => {
    generateTextMock.mockRejectedValue(apiError(503));
    await expect(validateAnthropicKey("sk-ant-good")).rejects.toMatchObject({
      message: "Provider key validation failed transiently (status 503)",
    });
    // the thrown error must NOT be the raw APICallError (which carries the auth header)
    await expect(
      validateAnthropicKey("sk-ant-good"),
    ).rejects.not.toBeInstanceOf(APICallError);
  });

  it("rethrows a sanitized error on a non-APICallError (network) failure", async () => {
    generateTextMock.mockRejectedValue(new Error("ECONNRESET socket hang up"));
    await expect(validateAnthropicKey("sk-ant-good")).rejects.toThrow(
      "Provider key validation failed transiently",
    );
  });
});

describe("validateOpenAiKey", () => {
  it("returns true when the ping succeeds", async () => {
    generateTextMock.mockResolvedValue({ text: "ok" });
    expect(await validateOpenAiKey("sk-openai-good")).toBe(true);
  });

  it.each([400, 401, 403, 429])(
    "returns false (invalid, surfaced — not a 500) on a %i client error",
    async (status) => {
      generateTextMock.mockRejectedValue(apiError(status));
      expect(await validateOpenAiKey("sk-openai-bad")).toBe(false);
    },
  );

  it("rethrows a SANITIZED error on a 5xx transient (no raw APICallError)", async () => {
    generateTextMock.mockRejectedValue(apiError(503));
    await expect(validateOpenAiKey("sk-openai-good")).rejects.toMatchObject({
      message: "Provider key validation failed transiently (status 503)",
    });
    await expect(
      validateOpenAiKey("sk-openai-good"),
    ).rejects.not.toBeInstanceOf(APICallError);
  });
});

describe("validateClaudeCodeKey (format-only — no network probe)", () => {
  it("accepts an API key AND a subscription setup-token (both sk-ant-)", async () => {
    expect(await validateClaudeCodeKey("sk-ant-api03-abc")).toBe(true);
    expect(await validateClaudeCodeKey("sk-ant-oat-abc")).toBe(true);
    expect(await validateClaudeCodeKey("  sk-ant-api03-abc  ")).toBe(true); // trims
  });

  it("rejects an empty or wrong-prefix value (surfaces a paste error on save)", async () => {
    expect(await validateClaudeCodeKey("")).toBe(false);
    expect(await validateClaudeCodeKey("   ")).toBe(false);
    expect(await validateClaudeCodeKey("not-a-key")).toBe(false);
  });

  it("never calls the model (an OAuth token can't be probed via x-api-key)", async () => {
    generateTextMock.mockClear();
    await validateClaudeCodeKey("sk-ant-oat-abc");
    expect(generateTextMock).not.toHaveBeenCalled();
  });
});

describe("validateGoogleKey", () => {
  it("returns true when the ping succeeds", async () => {
    generateTextMock.mockResolvedValue({ text: "ok" });
    expect(await validateGoogleKey("AIza-good")).toBe(true);
  });

  it.each([400, 401, 403, 429])(
    "returns false (invalid, surfaced — not a 500) on a %i client error",
    async (status) => {
      generateTextMock.mockRejectedValue(apiError(status));
      expect(await validateGoogleKey("AIza-bad")).toBe(false);
    },
  );

  it("rethrows a SANITIZED error on a 5xx transient (no raw APICallError)", async () => {
    generateTextMock.mockRejectedValue(apiError(503));
    await expect(validateGoogleKey("AIza-good")).rejects.toMatchObject({
      message: "Provider key validation failed transiently (status 503)",
    });
    await expect(validateGoogleKey("AIza-good")).rejects.not.toBeInstanceOf(
      APICallError,
    );
  });
});
