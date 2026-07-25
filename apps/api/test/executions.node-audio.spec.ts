// GET /executions/:id/nodes/:nodeId/audio — the SERVICE wiring (#689).
//
// The pure guards are covered in run-artifacts.spec.ts; this file proves the service actually
// CONSULTS them: a cross-tenant `__objectRef` planted in a run ctx 404s instead of streaming
// someone else's object, and a legitimate ref streams with an allow-listed content type.
import "reflect-metadata";
import { NotFoundException } from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";

const queryState = vi.hoisted(() => vi.fn());
const storeGet = vi.hoisted(() => vi.fn());

vi.mock("../src/executions/executions.queries", async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  queryState: (...a: unknown[]) => queryState(...a),
}));
vi.mock("@naary/storage", async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  getObjectStore: () => ({ get: storeGet }),
}));

import { ExecutionsService } from "../src/executions/executions.service";

const TENANT = "11111111-2222-3333-4444-555555555555";
const OTHER = "99999999-8888-7777-6666-555555555555";

/** The service's constructor collaborators are irrelevant to this read path. */
function makeService(): ExecutionsService {
  return new ExecutionsService({} as never, {} as never);
}

const ctxWith = (ref: string, contentType = "audio/mpeg") => ({
  ctx: {
    tts: {
      status: "ok",
      output: {
        audio: { __objectRef: ref, contentType, bytes: 3 },
        format: "mp3",
      },
    },
  },
});

beforeEach(() => {
  queryState.mockReset();
  storeGet.mockReset().mockResolvedValue(Buffer.from([1, 2, 3]));
});

describe("ExecutionsService.nodeAudio", () => {
  it("streams the bytes for the tenant's own audio object", async () => {
    const ref = `mem://tts/${TENANT}/wf-1/tts.mp3`;
    queryState.mockResolvedValue(ctxWith(ref));
    const out = await makeService().nodeAudio("wf-1", "tts", TENANT);
    expect(out.contentType).toBe("audio/mpeg");
    expect(out.filename).toBe("tts.mp3");
    expect(out.body).toEqual(Buffer.from([1, 2, 3]));
    expect(storeGet).toHaveBeenCalledWith(ref);
  });

  it("404s a CROSS-TENANT ref planted in the ctx, without touching storage", async () => {
    // What a hand-authored `set` node could emit to try to read another tenant's audio.
    queryState.mockResolvedValue(
      ctxWith(`s3://bucket/tts/${OTHER}/wf-9/tts.mp3`),
    );
    await expect(
      makeService().nodeAudio("wf-1", "tts", TENANT),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(storeGet).not.toHaveBeenCalled();
  });

  it("404s a non-audio prefix and an arbitrary URL ref, without touching storage", async () => {
    for (const ref of [
      `mem://codeagent-diff/${TENANT}/x.json`,
      "https://evil.example.com/steal.mp3",
      `mem://tts/${TENANT}/../../${OTHER}/tts.mp3`,
    ]) {
      queryState.mockResolvedValue(ctxWith(ref));
      await expect(
        makeService().nodeAudio("wf-1", "tts", TENANT),
      ).rejects.toBeInstanceOf(NotFoundException);
    }
    expect(storeGet).not.toHaveBeenCalled();
  });

  it("404s when the node produced no audio", async () => {
    queryState.mockResolvedValue({
      ctx: { tts: { status: "ok", output: {} } },
    });
    await expect(
      makeService().nodeAudio("wf-1", "tts", TENANT),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("404s (never 500s) when the object is gone from storage — the dev in-memory-store case", async () => {
    queryState.mockResolvedValue(ctxWith(`mem://tts/${TENANT}/wf-1/tts.mp3`));
    storeGet.mockRejectedValue(new Error("object not found"));
    await expect(
      makeService().nodeAudio("wf-1", "tts", TENANT),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("collapses a hostile stored content type to a non-rendering download", async () => {
    queryState.mockResolvedValue(
      ctxWith(`mem://tts/${TENANT}/wf-1/tts.mp3`, "text/html"),
    );
    const out = await makeService().nodeAudio("wf-1", "tts", TENANT);
    expect(out.contentType).toBe("application/octet-stream");
    expect(out.filename).toBe("tts.bin");
  });

  it("gates on the run's own access check (queryState does assertOwner + assertRunAccess)", async () => {
    queryState.mockRejectedValue(new NotFoundException("Execution not found"));
    await expect(
      makeService().nodeAudio("wf-1", "tts", TENANT),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(storeGet).not.toHaveBeenCalled();
  });
});
