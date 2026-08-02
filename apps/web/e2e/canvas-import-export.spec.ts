import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

/**
 * Import/Export round-trip on the canvas toolbar: Export downloads the current graph as a
 * portable `{ naaryFlow, name, graph }` JSON; Import loads such a file back as a new draft
 * (the name field updates). Runs against the default seeded canvas draft.
 */
test("export downloads a graph JSON, and import loads it back", async ({
  page,
}) => {
  await page.goto("/app/canvas");
  // Import/Export live in the top bar's "…" overflow menu now.
  await page.getByRole("button", { name: "More actions" }).click();
  await expect(page.getByRole("menuitem", { name: "Export" })).toBeVisible();

  // --- Export: capture the download and assert the file shape ---
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("menuitem", { name: "Export" }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/\.json$/);
  const dlPath = await download.path();
  expect(dlPath).toBeTruthy(); // null if downloads are disabled — fail clearly, not on readFileSync
  const exported = JSON.parse(readFileSync(dlPath as string, "utf8"));
  expect(exported.naaryFlow).toBe(1);
  expect(typeof exported.graph.startNodeId).toBe("string");
  // `Array.isArray(exported.graph.nodes)` is what this used to say, and `Array.isArray([])` is
  // `true` — so the canonical "I exported my workflow and got an empty file" regression satisfied
  // it. Measured: with `nodes: []`, EVERY assertion in this file passed, including the whole
  // import half below, and the canvas ended up rendering 0 nodes under a correct workflow name.
  // Assert against what was on the canvas instead.
  const onCanvas = await page.locator(".react-flow__node").count();
  expect(
    onCanvas,
    "nothing on the canvas to export — check global-setup's seed",
  ).toBeGreaterThan(0);
  expect(
    exported.graph.nodes.map((n: { id: string }) => n.id).sort(),
    "export dropped or invented nodes relative to the canvas",
  ).toEqual(
    await page
      .locator(".react-flow__node")
      .evaluateAll((els) => els.map((e) => e.getAttribute("data-id")).sort()),
  );

  // --- Import: write a renamed copy, load it, assert the name field updates ---
  //
  // The imported graph is deliberately DIFFERENT from what is on the canvas — one extra,
  // deliberately disconnected node. Re-importing the identical graph would make "3 nodes before"
  // and "3 nodes expected after" the same number, so a NO-OP import would satisfy the count: and
  // a no-op is precisely the regression in reach here, since `setName` (`useWorkflowActions.ts`)
  // runs downstream of the `setNodes`/`setEdges` try/catch and would survive it doing nothing.
  // A node the canvas did not previously have cannot appear unless the import really applied.
  const PROBE = "e2e-import-probe";
  const file = join(mkdtempSync(join(tmpdir(), "naary-e2e-")), "flow.json");
  writeFileSync(
    file,
    JSON.stringify({
      ...exported,
      name: "E2E Imported Flow",
      graph: {
        ...exported.graph,
        nodes: [
          ...exported.graph.nodes,
          { id: PROBE, type: "set", config: { fields: {} } },
        ],
      },
    }),
  );
  await page.locator('input[type="file"]').setInputFiles(file);

  await expect(
    page.getByRole("textbox", { name: "Workflow name" }),
  ).toHaveValue("E2E Imported Flow");
  await expect(page.getByText(/Imported "E2E Imported Flow"/)).toBeVisible();
  // The name field and the toast are set AFTER `setNodes`/`setEdges` succeed, so they do prove
  // `decompileGraph` did not throw — but they say nothing about what is ON SCREEN. `toFlowNodes`
  // returning nothing leaves the user staring at a blank canvas with a correct title, which is
  // exactly the state the empty-graph measurement above produced. Assert the graph came BACK,
  // and that it is the IMPORTED one.
  await expect(
    page.locator(`.react-flow__node[data-id="${PROBE}"]`),
  ).toBeVisible();
  await expect(page.locator(".react-flow__node")).toHaveCount(onCanvas + 1);
});
