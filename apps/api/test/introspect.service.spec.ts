import { BadRequestException } from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the network — keep the REAL BlockedEgressError so the service's `instanceof` mapping works.
const safeFetch = vi.hoisted(() => vi.fn());
vi.mock("@naary/connections", async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  safeFetch: (...a: unknown[]) => safeFetch(...a),
}));

import { BlockedEgressError } from "@naary/connections";
import { IntrospectService } from "../src/introspect/introspect.service";

/** A minimal Response whose body streams `text` once (what readCapped consumes). */
function streamRes(text: string): Response {
  const bytes = new TextEncoder().encode(text);
  let sent = false;
  return {
    body: {
      getReader: () => ({
        read: async () =>
          sent
            ? { done: true, value: undefined }
            : ((sent = true), { done: false, value: bytes }),
        cancel: async () => undefined,
        releaseLock: () => undefined,
      }),
    },
  } as unknown as Response;
}

let svc: IntrospectService;
beforeEach(() => {
  safeFetch.mockReset();
  svc = new IntrospectService();
});

describe("IntrospectService — SECURITY: never resolves $secrets", () => {
  it("forwards a `{{ $secrets.X }}` header VERBATIM (no server-side secret resolution → no exfiltration)", async () => {
    safeFetch.mockResolvedValue(streamRes(JSON.stringify({ paths: {} })));

    await svc.openapi("https://spec.example.com/openapi.json", {
      Authorization: "Bearer {{ $secrets.PROD_TOKEN }}",
    });

    // The token reference reached safeFetch UNCHANGED — the control plane never decrypted a secret.
    const init = safeFetch.mock.calls[0][1];
    expect(init.headers.Authorization).toBe("Bearer {{ $secrets.PROD_TOKEN }}");
  });
});

describe("IntrospectService.openapi", () => {
  it("fetches + parses a JSON spec into operations", async () => {
    safeFetch.mockResolvedValue(
      streamRes(
        JSON.stringify({
          openapi: "3.0.0",
          servers: [{ url: "https://api.x/v1" }],
          paths: { "/things": { get: { summary: "list" } } },
        }),
      ),
    );

    const out = await svc.openapi("https://spec.example.com/openapi.json");
    expect(out.baseUrl).toBe("https://api.x/v1");
    expect(out.operations).toEqual([
      {
        method: "GET",
        path: "/things",
        summary: "list",
        parameters: [],
        hasBody: false,
      },
    ]);
    expect(safeFetch.mock.calls[0][1].method).toBe("GET");
  });

  it("rejects a non-JSON (YAML) spec with a NAMED 400", async () => {
    safeFetch.mockResolvedValue(streamRes("openapi: 3.0.0\npaths: {}"));
    await expect(
      svc.openapi("https://spec.example.com/openapi.yaml"),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("maps a blocked egress target to a 400 (SSRF guard)", async () => {
    safeFetch.mockRejectedValue(new BlockedEgressError("private/reserved"));
    await expect(
      svc.openapi("https://169.254.169.254/spec"),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("requires a url", async () => {
    await expect(svc.openapi("")).rejects.toBeInstanceOf(BadRequestException);
    expect(safeFetch).not.toHaveBeenCalled();
  });
});

describe("IntrospectService.graphql", () => {
  it("POSTs the introspection query and summarizes the schema", async () => {
    safeFetch.mockResolvedValue(
      streamRes(
        JSON.stringify({
          data: {
            __schema: {
              queryType: { name: "Query" },
              types: [
                {
                  name: "Query",
                  kind: "OBJECT",
                  fields: [{ name: "me", args: [], type: { name: "User" } }],
                },
              ],
            },
          },
        }),
      ),
    );

    const out = await svc.graphql("https://api.x/graphql");
    expect(out.queryType).toBe("Query");
    expect(out.types[0].fields[0].name).toBe("me");
    const init = safeFetch.mock.calls[0][1];
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body).query).toContain("IntrospectionQuery");
  });
});
