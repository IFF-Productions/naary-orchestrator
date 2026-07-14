import { describe, expect, it, vi } from "vitest";
import { ExecutionsController } from "../src/executions/executions.controller";

// The rerun endpoint gained an optional RerunDto body. A legacy client that POSTs with
// no body must still re-run (against the latest graph), not 500 on an undefined-body read.
function makeController(
  rerun = vi.fn().mockResolvedValue({ workflowId: "wf" }),
) {
  const service = { rerun } as unknown as ConstructorParameters<
    typeof ExecutionsController
  >[0];
  return { controller: new ExecutionsController(service), rerun };
}

describe("ExecutionsController.rerun (body optional)", () => {
  it("re-runs with no graphVersion when the body is omitted (legacy caller)", async () => {
    const { controller, rerun } = makeController();
    // Call as NestJS would when no body is provided → the default {} applies.
    await (controller.rerun as (t: string, id: string) => Promise<unknown>)(
      "t1",
      "wf-old",
    );
    expect(rerun).toHaveBeenCalledWith("wf-old", "t1", undefined);
  });

  it("passes an explicit graphVersion through to the service", async () => {
    const { controller, rerun } = makeController();
    await controller.rerun("t1", "wf-old", { graphVersion: 2 });
    expect(rerun).toHaveBeenCalledWith("wf-old", "t1", 2);
  });
});
