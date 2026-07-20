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
  expect(Array.isArray(exported.graph.nodes)).toBe(true);
  expect(typeof exported.graph.startNodeId).toBe("string");

  // --- Import: write a renamed copy, load it, assert the name field updates ---
  const file = join(mkdtempSync(join(tmpdir(), "naary-e2e-")), "flow.json");
  writeFileSync(
    file,
    JSON.stringify({ ...exported, name: "E2E Imported Flow" }),
  );
  await page.locator('input[type="file"]').setInputFiles(file);

  await expect(
    page.getByRole("textbox", { name: "Workflow name" }),
  ).toHaveValue("E2E Imported Flow");
  await expect(page.getByText(/Imported "E2E Imported Flow"/)).toBeVisible();
});
