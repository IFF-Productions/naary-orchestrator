import { ConflictException } from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@naary/db", () => ({ getPrisma: () => ({}) }));

import { ExecutionsService } from "../src/executions/executions.service";

function makeService(status: string) {
  const query = vi
    .fn()
    .mockResolvedValue({ status, currentNodeId: "n", ctx: {} });
  const signal = vi.fn().mockResolvedValue(undefined);
  const service = new ExecutionsService({} as never, { defaultEnvId: async () => "env-test", resolveEnvId: async () => "env-test" } as never);
  (service as unknown as { client: unknown }).client = {
    workflow: { getHandle: () => ({ query, signal }) },
  };
  return { service, query, signal };
}

beforeEach(() => vi.clearAllMocks());

describe("decideByToken (public signed-link decision) — awaiting guard", () => {
  it("signals the decision when the run IS awaiting approval", async () => {
    const { service, signal } = makeService("awaiting_approval");
    await service.decideByToken("wf-1", true, "lgtm");
    expect(signal).toHaveBeenCalledOnce();
    expect(signal.mock.calls[0][1]).toEqual({
      approved: true,
      comment: "lgtm",
    });
  });

  it("REFUSES (409) and never signals when the run is NOT awaiting (stale link)", async () => {
    const { service, signal } = makeService("completed");
    await expect(service.decideByToken("wf-1", true)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(signal).not.toHaveBeenCalled();
  });
});
