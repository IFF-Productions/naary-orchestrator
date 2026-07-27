import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Nothing may animate `transform` on `.react-flow__node`.
 *
 * React Flow positions every node with an inline `transform: translate(x, y)` on that element. A CSS
 * animation on the same element that touches `transform` WINS over the inline style — animations
 * outrank inline declarations in the cascade — and with `fill-mode: both` the last keyframe keeps
 * applying after the animation ends. The node then parks wherever the keyframe says, its edges keep
 * drawing to its real position, and dragging silently does nothing because React Flow's updated
 * inline transform stays overridden.
 *
 * That shipped: an "appear" animation on the node wrapper made every NEWLY ADDED node land in the
 * wrong place with an edge trailing into empty space, and pinned it there — "I can move every node
 * except the one I just added". Saved nodes were fine because only added ones carry the class.
 *
 * The safe pattern is to animate the CARD inside the wrapper. This test allows that and rejects the
 * wrapper, because the failure is invisible until someone tries to drag.
 */

const CSS = resolve(__dirname, "../src/screens/canvas.css");
const css = readFileSync(CSS, "utf8");

/** Strip comments so prose about `transform` can't trip the checks below. */
const code = css.replace(/\/\*[\s\S]*?\*\//g, "");

/** `@keyframes NAME { … }` → the body, for every keyframes block in the file. */
function keyframeBodies(): Map<string, string> {
  const out = new Map<string, string>();
  const re = /@keyframes\s+([\w-]+)\s*\{/g;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex.exec loop
  while ((m = re.exec(code)) !== null) {
    let depth = 1;
    let i = re.lastIndex;
    while (i < code.length && depth > 0) {
      if (code[i] === "{") depth++;
      else if (code[i] === "}") depth--;
      i++;
    }
    out.set(m[1], code.slice(re.lastIndex, i - 1));
  }
  return out;
}

/** Rule blocks as [selector, body] pairs, skipping @-blocks' own headers. */
function rules(): [string, string][] {
  const out: [string, string][] = [];
  const re = /([^{}@][^{}]*)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex.exec loop
  while ((m = re.exec(code)) !== null) {
    out.push([m[1].trim(), m[2]]);
  }
  return out;
}

describe("canvas.css does not fight React Flow's node positioning", () => {
  const frames = keyframeBodies();
  const all = rules();

  /** Guards the guard: an unreadable file or a broken parse must fail, not pass vacuously. */
  it("parsed the stylesheet", () => {
    expect(css.length).toBeGreaterThan(1000);
    expect(frames.size).toBeGreaterThan(3);
    expect(all.length).toBeGreaterThan(20);
    expect(frames.has("naaryNodeEnter")).toBe(true);
  });

  /** The keyframes themselves are fine — animating transform is the whole point of an entrance. */
  it("naaryNodeEnter still animates transform (it is an entrance)", () => {
    expect(frames.get("naaryNodeEnter")).toMatch(/transform/);
  });

  it("no rule animates transform on the positioned node wrapper", () => {
    const offenders: string[] = [];
    for (const [selector, body] of all) {
      // Only the WRAPPER itself. A descendant selector (`.react-flow__node … .naary-node-card`) is
      // the correct pattern and must keep working.
      const targetsWrapper = selector
        .split(",")
        .map((s) => s.trim())
        .some((s) => /\.react-flow__node[\w.-]*$/.test(s));
      if (!targetsWrapper) continue;

      if (/(^|[\s;])transform\s*:/.test(body)) {
        offenders.push(`${selector} — sets transform directly`);
      }
      for (const decl of body.match(/animation[^;]*/g) ?? []) {
        for (const [name, frameBody] of frames) {
          if (decl.includes(name) && /transform/.test(frameBody)) {
            offenders.push(
              `${selector} — animates ${name}, which sets transform`,
            );
          }
        }
      }
    }
    expect(
      offenders,
      `Animate the CARD (\`.naary-node-card\`) instead — React Flow owns the wrapper's transform:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
