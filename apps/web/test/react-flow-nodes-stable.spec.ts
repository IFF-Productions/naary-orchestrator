/**
 * Regression guard: a <ReactFlow> nodes array must be a STABLE reference, not rebuilt per render.
 *
 * Why this matters beyond wasted work. React Flow re-adopts the `nodes` prop on every render;
 * `adoptUserNodes` (@xyflow/system) only keeps a node's `measured` box while the node OBJECT is the
 * same one it saw last time — a freshly-built object resets `measured` to undefined. NodeWrapper
 * (@xyflow/react) renders `visibility: hasDimensions ? 'visible' : 'hidden'`, so every node blinks
 * out until the shared ResizeObserver re-measures it a frame later. On a screen that fetches in
 * several waves (WorkflowDetail fires six), each response that lands re-renders and re-blinks the
 * whole diagram — a visible flicker, and on a slow CI box a wide enough hidden window to fail an
 * e2e that asks whether a node is visible (apps/web/e2e/workflow-diagram.spec.ts flaked exactly
 * that way: the element PRESENT, its value `hidden`, 22 times over).
 *
 * This is a source scan because apps/web's vitest environment is `node` — there is no
 * jsdom/testing-library here to render a screen and read back a computed style (same reason
 * overlay-containing-block.spec.ts scans source).
 */
import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(__dirname, "../src");

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else if (/\.tsx$/.test(e.name)) out.push(p);
  }
  return out;
}

/** `flow.nodes` → `flow`; `nodes` → `nodes`. The binding whose identity has to hold. */
function rootIdentifier(expr: string): string {
  return expr.trim().split(/[.[\s]/)[0];
}

/**
 * Stable enough: produced by a hook that preserves identity between renders (useMemo / useState /
 * React Flow's own node state), or declared at MODULE scope (a fixture in a story). A binding this
 * file doesn't declare at all is a prop or an import — its stability is the caller's job, and the
 * caller is covered by this same rule.
 */
function isStable(text: string, root: string): boolean {
  const declares = new RegExp(
    `\\b(?:const|let|var)\\s+[^=;\\n]*\\b${root}\\b[^=;\\n]*=`,
  ).test(text);
  if (!declares) return true;
  const hookBound = new RegExp(
    // The hook may carry a type argument: `useState<Node<NaaryData>[]>(SEED_NODES)`.
    `\\b(?:const|let)\\s+(?:\\[\\s*${root}\\b[^\\]]*\\]|\\{[^}]*\\b${root}\\b[^}]*\\}|${root})\\s*=\\s*(?:useMemo|useState|useNodesState|useEdgesState)\\s*(?:<[^(]*>)?\\s*\\(`,
  ).test(text);
  const moduleScope = new RegExp(
    `^(?:const|let)\\s+(?:\\[\\s*${root}\\b[^\\]]*\\]|\\{[^}]*\\b${root}\\b[^}]*\\}|${root})\\b[^=]*=`,
    "m",
  ).test(text);
  return hookBound || moduleScope;
}

describe("react-flow node arrays keep their identity across renders", () => {
  it("every <ReactFlow nodes={…}> is bound to a memoized/stateful value", async () => {
    const offenders: string[] = [];
    let checked = 0;
    for (const file of await walk(SRC)) {
      const text = readFileSync(file, "utf8");
      if (!text.includes("<ReactFlow")) continue;
      for (const m of text.matchAll(/\bnodes=\{([^}]+)\}/g)) {
        checked++;
        const root = rootIdentifier(m[1]);
        if (!isStable(text, root)) {
          offenders.push(`${path.relative(SRC, file)} → nodes={${m[1]}}`);
        }
      }
    }
    // The scan is only meaningful if it actually found the canvases.
    expect(checked).toBeGreaterThanOrEqual(4);
    expect(offenders).toEqual([]);
  });
});
