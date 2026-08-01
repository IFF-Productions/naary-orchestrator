/**
 * Drift guard: the playful progress copy has ONE list and ONE rotator.
 *
 * This repo keeps re-landing the same bug — a second copy of a shared string list that then only
 * gets updated on one side (#982, #984, #1005). The progress copy had started down it: two
 * byte-identical `setInterval(… nextProgressMessage …)` effects, in the canvas hook and Simple
 * mode's generate screen, and a third surface (Build with AI, #1022) wanting the same thing. They
 * now all call `useRotatingProgressMessage`.
 *
 * A source scan rather than a render test because apps/web's vitest environment is `node` — there
 * is no jsdom/testing-library here (same reason react-flow-nodes-stable.spec.ts scans source).
 */
import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PROGRESS_MESSAGES } from "../src/lib/progress-messages";

const SRC = path.resolve(__dirname, "../src");
/** Where the list lives, and the one module allowed to turn it into a rotation. */
const LIST = path.join(SRC, "lib/progress-messages.ts");
const ROTATOR = path.join(SRC, "lib/use-progress-message.ts");

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else if (/\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

describe("progress-message rotation is single-sourced", () => {
  it("only the rotator hook imports the message list", async () => {
    const offenders: string[] = [];
    for (const file of await walk(SRC)) {
      if (file === LIST || file === ROTATOR) continue;
      const text = readFileSync(file, "utf8");
      // Any import whose specifier ends in `progress-messages` — however deep the relative path.
      if (/from\s+["'][^"']*\/progress-messages["']/.test(text)) {
        offenders.push(path.relative(SRC, file));
      }
    }
    expect(
      offenders,
      "these reach past the hook to the raw list — rotate via useRotatingProgressMessage instead",
    ).toEqual([]);
  });

  it("no file re-declares a message from the list", async () => {
    const offenders: string[] = [];
    for (const file of await walk(SRC)) {
      if (file === LIST) continue;
      const text = readFileSync(file, "utf8");
      const copied = PROGRESS_MESSAGES.filter((m) => text.includes(m));
      if (copied.length > 0) {
        offenders.push(`${path.relative(SRC, file)}: ${copied.join(", ")}`);
      }
    }
    expect(offenders, "a second copy of the list is the drift bug").toEqual([]);
  });

  it("the rotator owns the only timer over these messages", () => {
    const rotator = readFileSync(ROTATOR, "utf8");
    expect(rotator).toContain("setInterval(");
    // The timer must not outlive the work it describes: cleared when `active` flips and on unmount.
    expect(rotator).toContain("clearInterval(");
  });

  it("Build with AI shows the rotating copy while a turn warms up (#1022)", () => {
    const panel = readFileSync(
      path.join(SRC, "screens/app/build-ai/ConversationPanel.tsx"),
      "utf8",
    );
    expect(panel).toContain("useRotatingProgressMessage");
    // ...and stops the moment real plan lines exist, so playful copy never competes with the
    // Building card's real frames. Also page-only: the canvas already rotates over its own stage.
    expect(panel).toMatch(/typing\s*&&\s*!plan\s*&&\s*!embedded/);
  });
});
