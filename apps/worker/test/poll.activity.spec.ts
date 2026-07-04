import { beforeEach, describe, expect, it, vi } from "vitest";
import { __pollDeps, callPoll } from "../src/temporal/activities";

const META = { tenantId: "t1", workflowKey: "wf", nodeId: "poll" };

function jsonResponse(body: unknown): Response {
  return { text: async () => JSON.stringify(body) } as unknown as Response;
}

let cursor: string | null;
const fetch = vi.fn();
const writeCursor = vi.fn();

beforeEach(() => {
  cursor = null;
  fetch.mockReset();
  writeCursor.mockReset().mockResolvedValue(undefined);
  __pollDeps.assertEgressAllowed = vi
    .fn()
    .mockResolvedValue(undefined) as never;
  __pollDeps.fetch = ((url: string) => fetch(url)) as never;
  __pollDeps.readCursor = (async () => cursor) as never;
  __pollDeps.writeCursor = writeCursor as never;
});

describe("callPoll (change-detection)", () => {
  it("first poll (no cursor) → changed=true and stores the key", async () => {
    fetch.mockResolvedValue(jsonResponse({ id: 1 }));

    const r = await callPoll({ url: "https://x/y", intervalSeconds: 60 }, META);

    expect(r.changed).toBe(true);
    expect(r.body).toEqual({ id: 1 });
    expect(writeCursor).toHaveBeenCalledOnce();
  });

  it("unchanged source → changed=false and does NOT advance the cursor", async () => {
    // First call seeds the cursor; capture the key it stored.
    fetch.mockResolvedValue(jsonResponse({ id: 1 }));
    await callPoll({ url: "https://x/y", intervalSeconds: 60 }, META);
    cursor = writeCursor.mock.calls[0][1]; // the stored key
    writeCursor.mockClear();

    const r = await callPoll({ url: "https://x/y", intervalSeconds: 60 }, META);

    expect(r.changed).toBe(false);
    expect(writeCursor).not.toHaveBeenCalled();
  });

  it("changed source → changed=true and advances the cursor", async () => {
    cursor = "stale-key-that-wont-match";
    fetch.mockResolvedValue(jsonResponse({ id: 2 }));

    const r = await callPoll({ url: "https://x/y", intervalSeconds: 60 }, META);

    expect(r.changed).toBe(true);
    expect(writeCursor).toHaveBeenCalledOnce();
  });

  it("changeKey selects a field: same key, different noise → NOT changed", async () => {
    const cfg = { url: "https://x/y", intervalSeconds: 60, changeKey: "id" };
    fetch.mockResolvedValue(jsonResponse({ id: 7, ts: "a" }));
    await callPoll(cfg, META);
    cursor = writeCursor.mock.calls[0][1];
    writeCursor.mockClear();

    // id unchanged, only the noisy `ts` differs → the change key is the same.
    fetch.mockResolvedValue(jsonResponse({ id: 7, ts: "b" }));
    const r = await callPoll(cfg, META);

    expect(r.changed).toBe(false);
  });

  it("returns raw text body when the response isn't JSON", async () => {
    fetch.mockResolvedValue({ text: async () => "plain text" } as never);

    const r = await callPoll({ url: "https://x/y", intervalSeconds: 60 }, META);

    expect(r.body).toBe("plain text");
    expect(r.changed).toBe(true);
  });
});
