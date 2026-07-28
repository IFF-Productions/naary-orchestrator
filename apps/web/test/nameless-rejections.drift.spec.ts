import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A promise rejected with NOTHING — or with a DOM `Event` — reaches Sentry with no message, no
 * stack and no target. #793 is what that looks like in practice: an issue filed with the literal
 * title `<unknown>` and the body `Event `Event` (type=error) captured as promise rejection`,
 * which says nothing about which of several promisified `onerror` handlers produced it.
 *
 * `nameEventRejection` (instrument.ts) recovers the target for THIRD-PARTY scripts we don't
 * control. For our own call sites the fix is simply to say what failed — and this stops the next
 * one being written, because the cost isn't paid until something breaks in production and the
 * report turns out to be unreadable.
 *
 * WHAT THIS FORBIDS: `reject()` with no argument, and `reject(e)` where `e` is the DOM event
 * parameter of an error handler. Rejecting with an `Error` — of any message — is fine.
 */

const SRC = resolve(__dirname, "../src");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(p) && !p.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

/** `reject()` — a rejection whose reason is `undefined`. Nothing downstream can name it. */
const BARE_REJECT = /(?<![.\w])reject\(\s*\)/;

/**
 * `reject(e)` / `reject(err)` / `reject(event)` — the DOM-event parameter passed straight through,
 * which is the exact shape #793 arrived as. A named Error variable (`reject(failure)`) is allowed:
 * the point is not to ban indirection, it's to ban passing the raw event.
 */
const REJECT_RAW_EVENT = /(?<![.\w])reject\(\s*(e|ev|evt|event|err)\s*\)/;

describe("promise rejections say what failed (#793)", () => {
  const files = walk(SRC);

  it("scans a plausible number of files", () => {
    // Without this the suite passes silently if the walk ever breaks — the same vacuum that let a
    // catalog test sit green while checking nothing.
    expect(files.length).toBeGreaterThan(100);
  });

  it("has no bare `reject()` anywhere in apps/web/src", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      src.split("\n").forEach((line, i) => {
        if (
          line.trimStart().startsWith("//") ||
          line.trimStart().startsWith("*")
        )
          return;
        if (BARE_REJECT.test(line))
          offenders.push(`${relative(SRC, f)}:${i + 1}  ${line.trim()}`);
      });
    }

    expect(
      offenders,
      `reject() with no reason produces a Sentry report with no message — reject(new Error("…")) instead:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("never rejects with a raw error-handler event", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      src.split("\n").forEach((line, i) => {
        if (
          line.trimStart().startsWith("//") ||
          line.trimStart().startsWith("*")
        )
          return;
        if (REJECT_RAW_EVENT.test(line))
          offenders.push(`${relative(SRC, f)}:${i + 1}  ${line.trim()}`);
      });
    }

    expect(
      offenders,
      `a DOM Event as a rejection reason is #793 exactly — wrap it in an Error that names the target:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
