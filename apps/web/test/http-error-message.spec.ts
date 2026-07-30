import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/firebase-lazy", () => ({
  getBearerToken: async () => "t",
}));

import { http, type HttpError } from "../src/lib/api/http";

/**
 * The server's REASON must reach `e.message`.
 *
 * Reported as `POST /graphs/…/nodes/hasincidents/test → 404` with no explanation, while the API had
 * answered "No node 'hasincidents' in this graph" — the entire diagnosis. That text lived only on
 * `serverMessage`, which SIX call sites in the whole app unwrap, so by default the app hid its own
 * answer and a reader had to opt in to being told what happened.
 */
afterEach(() => vi.restoreAllMocks());

function failWith(status: number, body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      status,
      ok: false,
      headers: { get: () => null },
      json: async () => body,
    } as unknown as Response),
  );
}

const err = (p: Promise<unknown>) => p.catch((e) => e as HttpError);

describe("http() error message", () => {
  it("leads with the server's reason and keeps the request context", async () => {
    failWith(404, { message: "No node 'hasincidents' in this graph" });
    const e = await err(
      http("/graphs/x/nodes/hasincidents/test", { method: "POST" }),
    );
    expect(e.message).toBe(
      "No node 'hasincidents' in this graph (POST /graphs/x/nodes/hasincidents/test → 404)",
    );
    // The existing accessor still works — six call sites read it.
    expect(e.serverMessage).toBe("No node 'hasincidents' in this graph");
    expect(e.status).toBe(404);
  });

  it("takes the first of class-validator's string[]", async () => {
    failWith(400, { message: ["workflowKey must be a string", "and more"] });
    const e = await err(http("/graphs", { method: "POST" }));
    expect(e.message).toContain("workflowKey must be a string");
    expect(e.message).not.toContain("and more");
  });

  it("falls back to context alone when the body says nothing usable", async () => {
    for (const body of [null, {}, { message: "   " }, { message: 42 }]) {
      failWith(500, body);
      const e = await err(http("/x"));
      expect(e.message).toBe("GET /x → 500");
      expect(e.serverMessage).toBeUndefined();
    }
  });
});
