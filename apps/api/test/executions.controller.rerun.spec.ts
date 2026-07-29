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
  return {
    controller: new ExecutionsController(
      service,
      {
        defaultEnvId: async () => "e1",
        resolveEnvId: async () => "e1",
      } as never,
      // NotificationsService — only the "Remind now" endpoint uses it.
      { sendApprovalReminder: vi.fn() } as never,
    ),
    rerun,
  };
}

describe("ExecutionsController.rerun (body optional)", () => {
  it("re-runs with no graphVersion when the body is omitted (legacy caller)", async () => {
    const { controller, rerun } = makeController();
    // Call as NestJS would when no body is provided → the default {} applies.
    await (controller.rerun as (t: string, id: string) => Promise<unknown>)(
      "t1",
      "wf-old",
    );
    // Trailing undefineds = the optional graphVersion + G1 actor params; debug defaults OFF,
    // so a bodyless legacy re-run is byte-identical to before the flag was exposed.
    expect(rerun).toHaveBeenCalledWith(
      "wf-old",
      "t1",
      undefined,
      undefined,
      false,
    );
  });

  it("passes an explicit graphVersion through to the service", async () => {
    const { controller, rerun } = makeController();
    await controller.rerun("t1", "wf-old", { graphVersion: 2 });
    expect(rerun).toHaveBeenCalledWith("wf-old", "t1", 2, undefined, false);
  });

  // "Re-run with debug" in the run-detail menu POSTs {debug:true} with no version — the run
  // detail's per-node debug rows exist only for runs started with it.
  it("passes debug:true through to the service", async () => {
    const { controller, rerun } = makeController();
    await controller.rerun("t1", "wf-old", { debug: true });
    expect(rerun).toHaveBeenCalledWith(
      "wf-old",
      "t1",
      undefined,
      undefined,
      true,
    );
  });
});
