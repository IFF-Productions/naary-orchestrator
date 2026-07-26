/**
 * The canvas's return target (src/lib/canvas-return.ts).
 *
 * `?from=` is attacker-controllable — it comes off the URL and is handed to navigate() — so the
 * validation half of this file is a SECURITY test, not a formatting one. The rest pins the two
 * behaviours that made the feature necessary: the label naming the destination, and the target
 * surviving the canvas rewriting its own search params.
 */
import { describe, expect, it } from "vitest";
import {
  CANVAS_HOME,
  canvasTo,
  RETURN_PARAM,
  returnLabel,
  safeReturnTo,
  withReturn,
} from "../src/lib/canvas-return";

describe("safeReturnTo", () => {
  it("accepts in-app paths under /app", () => {
    expect(safeReturnTo("/app")).toBe("/app");
    expect(safeReturnTo("/app/runs")).toBe("/app/runs");
    expect(safeReturnTo("/app/runs/abc-123")).toBe("/app/runs/abc-123");
    expect(safeReturnTo("/app/runs?status=failed")).toBe(
      "/app/runs?status=failed",
    );
    expect(safeReturnTo("/app/workflows#top")).toBe("/app/workflows#top");
  });

  it("trims surrounding whitespace", () => {
    expect(safeReturnTo("  /app/runs  ")).toBe("/app/runs");
  });

  // OPEN REDIRECT — the whole reason this function exists.
  it.each([
    ["an absolute off-site URL", "https://evil.test/app"],
    ["a protocol-relative host", "//evil.test"],
    ["a protocol-relative host that mimics the prefix", "//evil.test/app"],
    ["a javascript: URL", "javascript:alert(1)"],
    ["a data: URL", "data:text/html,<script>1</script>"],
    ["a backslash-folded host", "/\\evil.test"],
    ["a scheme-relative with credentials", "//user@evil.test/app"],
  ])("rejects %s", (_label, value) => {
    expect(safeReturnTo(value)).toBeNull();
  });

  // Traversal: the browser normalizes `..` BEFORE we would see the result, so "/app/../x"
  // would escape the /app prefix this function just verified.
  it.each(["/app/../auth", "/app/../../etc", "/app/a/../../x"])(
    "rejects traversal (%s)",
    (value) => {
      expect(safeReturnTo(value)).toBeNull();
    },
  );

  it("rejects in-app paths that are not under /app", () => {
    expect(safeReturnTo("/auth")).toBeNull();
    expect(safeReturnTo("/f/some-form")).toBeNull();
    expect(safeReturnTo("/approve/wf-1")).toBeNull();
    // "/application" must not pass as "/app" + something.
    expect(safeReturnTo("/application")).toBeNull();
  });

  it("rejects a relative path (no leading slash)", () => {
    expect(safeReturnTo("app/runs")).toBeNull();
  });

  it("rejects empty and absent values", () => {
    expect(safeReturnTo(null)).toBeNull();
    expect(safeReturnTo(undefined)).toBeNull();
    expect(safeReturnTo("")).toBeNull();
    expect(safeReturnTo("   ")).toBeNull();
  });

  it("rejects an absurdly long value", () => {
    expect(safeReturnTo(`/app/${"x".repeat(600)}`)).toBeNull();
  });
});

describe("canvasTo", () => {
  it("appends the return target with ? when the URL has no query", () => {
    expect(canvasTo("/app/canvas", "/app/runs")).toBe(
      `/app/canvas?${RETURN_PARAM}=%2Fapp%2Fruns`,
    );
  });

  it("appends with & when the URL already has a query", () => {
    expect(canvasTo("/app/canvas?key=refunds", "/app/workflows")).toBe(
      `/app/canvas?key=refunds&${RETURN_PARAM}=%2Fapp%2Fworkflows`,
    );
  });

  it("encodes a return path that itself has a query", () => {
    const url = canvasTo("/app/canvas", "/app/runs?status=failed");
    // Round-trips through the param without swallowing the nested query.
    const parsed = new URLSearchParams(url.slice(url.indexOf("?")));
    expect(parsed.get(RETURN_PARAM)).toBe("/app/runs?status=failed");
  });

  it("leaves the URL untouched when the origin is not a safe in-app path", () => {
    expect(canvasTo("/app/canvas", "https://evil.test")).toBe("/app/canvas");
  });
});

describe("withReturn", () => {
  // The canvas replaces its params outright when switching workflows; a fresh object would
  // drop `from` and strand the back control on /app mid-session.
  it("carries the return target into a rewritten param set", () => {
    expect(withReturn({ key: "refunds" }, "/app/runs")).toEqual({
      key: "refunds",
      [RETURN_PARAM]: "/app/runs",
    });
  });

  it("carries it even when clearing every other param", () => {
    expect(withReturn({}, "/app/runs")).toEqual({
      [RETURN_PARAM]: "/app/runs",
    });
  });

  it("omits it when there is none (params unchanged)", () => {
    expect(withReturn({ key: "refunds" }, null)).toEqual({ key: "refunds" });
  });

  it("drops an unsafe target rather than propagating it", () => {
    expect(withReturn({ key: "a" }, "//evil.test")).toEqual({ key: "a" });
  });
});

describe("returnLabel", () => {
  it("names the section so the control says where it goes", () => {
    expect(returnLabel("/app/runs")).toBe("Back to Runs");
    expect(returnLabel("/app/runs/abc-123")).toBe("Back to Runs");
    expect(returnLabel("/app/workflows")).toBe("Back to Workflows");
    expect(returnLabel("/app/runs?status=failed")).toBe("Back to Runs");
    expect(returnLabel(CANVAS_HOME)).toBe("Back to Overview");
  });

  it("falls back to a generic label for an unknown or unsafe target", () => {
    expect(returnLabel("/app/some-new-screen")).toBe("Back to Naary");
    expect(returnLabel("https://evil.test")).toBe("Back to Naary");
    expect(returnLabel(null)).toBe("Back to Naary");
  });
});
