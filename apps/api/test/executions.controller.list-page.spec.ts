import { describe, expect, it, vi } from "vitest";
import { ExecutionsController } from "../src/executions/executions.controller";

/**
 * `GET /executions/page` — the Runs screen's cursor-paged list. Query params arrive as STRINGS from
 * Express, so this pins the parsing: everything the SPA can put in the URL must reach `listPage` as
 * the right type, and a junk value must degrade to the default rather than reaching Prisma's `take`.
 *
 * The keyset behaviour itself is covered by executions.list-page.spec.ts (service level); this is
 * the controller seam only.
 */
function makeController(
  listPage = vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
) {
  const service = { listPage } as unknown as ConstructorParameters<
    typeof ExecutionsController
  >[0];
  return {
    controller: new ExecutionsController(
      service,
      {
        defaultEnvId: async () => "e1",
        resolveEnvId: async () => "e1",
      } as never,
      { sendApprovalReminder: vi.fn() } as never,
    ),
    listPage,
  };
}

/** The opts object the controller handed to the service. */
const optsOf = (listPage: ReturnType<typeof vi.fn>) =>
  listPage.mock.calls[0][1] as Record<string, unknown>;

describe("ExecutionsController.listRunsPage", () => {
  it("first page: no cursor, no limit, active (non-archived) view", async () => {
    const { controller, listPage } = makeController();
    await controller.listRunsPage("t1");
    expect(optsOf(listPage)).toEqual({ archived: false });
  });

  it("passes the cursor through verbatim (it's opaque — never parsed here)", async () => {
    const { controller, listPage } = makeController();
    await controller.listRunsPage("t1", undefined, undefined, "CURSOR-abc");
    expect(optsOf(listPage)).toEqual({
      archived: false,
      cursor: "CURSOR-abc",
    });
  });

  it("parses limit to a number (Express hands it over as a string)", async () => {
    const { controller, listPage } = makeController();
    await controller.listRunsPage("t1", undefined, undefined, undefined, "25");
    expect(optsOf(listPage)).toEqual({ archived: false, limit: 25 });
  });

  /**
   * The important one. `Number("abc")` is NaN, and a NaN reaching Prisma's `take` throws — so a
   * hand-edited URL would 500 the Runs screen. Non-numeric, zero and negative all fall back to the
   * service default instead.
   */
  it.each(["abc", "", "0", "-5", "NaN", "Infinity"])(
    "ignores a nonsense limit (%s) instead of passing NaN to the query",
    async (limit) => {
      const { controller, listPage } = makeController();
      await controller.listRunsPage(
        "t1",
        undefined,
        undefined,
        undefined,
        limit,
      );
      expect(optsOf(listPage)).toEqual({ archived: false });
    },
  );

  it("treats archived=true as the archived view, anything else as active", async () => {
    for (const [raw, expected] of [
      ["true", true],
      ["false", false],
      [undefined, false],
      ["1", false], // only the literal "true" opts in, matching GET /executions
    ] as const) {
      const { controller, listPage } = makeController();
      await controller.listRunsPage("t1", raw);
      expect(optsOf(listPage).archived).toBe(expected);
    }
  });

  it("forwards the search term so search composes with paging", async () => {
    const { controller, listPage } = makeController();
    await controller.listRunsPage("t1", undefined, "invoice");
    expect(optsOf(listPage)).toEqual({ archived: false, q: "invoice" });
  });

  it("omits an empty search rather than sending q=''", async () => {
    const { controller, listPage } = makeController();
    await controller.listRunsPage("t1", undefined, "");
    expect(optsOf(listPage)).toEqual({ archived: false });
  });

  /** G3 (§8.4): the principal must reach listPage, or a restricted member's page would be
   *  filtered client-side (i.e. not at all) and leak runs they may not view. */
  it("forwards the principal so the view filter applies inside the query", async () => {
    const { controller, listPage } = makeController();
    const principal = { sub: "u1", role: "member" } as never;
    await controller.listRunsPage(
      "t1",
      undefined,
      undefined,
      undefined,
      undefined,
      principal,
    );
    expect(listPage.mock.calls[0][2]).toBe(principal);
  });

  it("returns the { items, nextCursor } envelope the client pages on", async () => {
    const items = [{ workflowId: "wf-1" }];
    const { controller } = makeController(
      vi.fn().mockResolvedValue({ items, nextCursor: "NEXT" }),
    );
    await expect(controller.listRunsPage("t1")).resolves.toEqual({
      items,
      nextCursor: "NEXT",
    });
  });
});
