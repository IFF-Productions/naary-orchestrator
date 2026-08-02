// The Runs list must never be able to render NOTHING (#1044).
//
// `Runs.tsx` destructured the paged response directly — `const { items: rows } = await
// api.listRunsPage(…); setRuns(rows)`. A 200 whose body has no `items` key therefore set the list
// to `undefined`, and from there the screen showed nothing at all:
//
//   · `runs === null`      → false, so no loading skeleton;
//   · `runs?.length === 0` → false, so no "No runs yet" empty state;
//   · nothing threw        → no error banner.
//
// A blank screen with no stated reason is the worst possible outcome: it is indistinguishable from
// "still loading", which is exactly what cost a diagnosis round-trip on #1038. These tests pin the
// contract that replaces it — a wrong-shaped response is an ERROR the user can read, never silence.
import { describe, expect, it } from "vitest";
import { HttpError, UnauthorizedError } from "../src/lib/api";
import type { RunSummary } from "../src/lib/api";
import {
  appendRunPage,
  readRunPage,
  runsLoadErrorMessage,
  UnexpectedResponseError,
} from "../src/screens/app/runs-model";

const run = (id: string): RunSummary =>
  ({ workflowId: id, status: "completed" }) as RunSummary;

const FALLBACK = "Could not reach the control plane (apps/api on :3000).";

describe("readRunPage — the shape the contract promises", () => {
  it("passes a well-formed page through untouched", () => {
    const page = readRunPage({ items: [run("a"), run("b")], nextCursor: "c1" });
    expect(page.items.map((r) => r.workflowId)).toEqual(["a", "b"]);
    expect(page.nextCursor).toBe("c1");
  });

  it("reads the last page (nextCursor null) as the last page", () => {
    expect(readRunPage({ items: [], nextCursor: null }).nextCursor).toBeNull();
  });

  it("THROWS on a 200 with no `items` — never returns undefined rows", () => {
    // The bug: this used to return `{ items: undefined }`, which became `setRuns(undefined)`
    // and a screen with no skeleton, no empty state and no error.
    expect(() => readRunPage({ nextCursor: null })).toThrow(
      UnexpectedResponseError,
    );
    // The message has to say what is wrong — "unexpected" alone is not a diagnosis.
    expect(() => readRunPage({ nextCursor: null })).toThrow(/items/);
  });

  it("THROWS on the other shapes a mismatched API/proxy actually returns", () => {
    // A single run object (an older API answering /executions/page via @Get(":id")).
    expect(() => readRunPage({ workflowId: "exec-1" })).toThrow(
      UnexpectedResponseError,
    );
    // A bare array (the un-paged /executions shape).
    expect(() => readRunPage([run("a")])).toThrow(UnexpectedResponseError);
    // `items` present but not an array.
    expect(() => readRunPage({ items: "nope" })).toThrow(
      UnexpectedResponseError,
    );
    // Nothing at all — an empty body parsed to undefined/null.
    expect(() => readRunPage(undefined)).toThrow(UnexpectedResponseError);
    expect(() => readRunPage(null)).toThrow(UnexpectedResponseError);
  });

  it("normalizes a missing/!string nextCursor to null rather than trusting it", () => {
    // `undefined` here would leave the "Load more" button wired to a cursor that isn't one.
    expect(readRunPage({ items: [] }).nextCursor).toBeNull();
    expect(readRunPage({ items: [], nextCursor: 42 }).nextCursor).toBeNull();
  });
});

describe("appendRunPage — a bad page must not corrupt a good list", () => {
  it("appends and dedupes on workflowId", () => {
    const prev = [run("a"), run("b")];
    const next = appendRunPage(prev, {
      items: [run("b"), run("c")],
      nextCursor: null,
    });
    expect(next.map((r) => r.workflowId)).toEqual(["a", "b", "c"]);
  });

  it("appends onto an empty/null list", () => {
    expect(
      appendRunPage(null, { items: [run("a")], nextCursor: null }).map(
        (r) => r.workflowId,
      ),
    ).toEqual(["a"]);
  });

  it("THROWS before touching the list when page 2 has no `items`", () => {
    // In the component this ran INSIDE a `setRuns(prev => …)` updater, which React runs during a
    // later render unless it can evaluate it eagerly — so the TypeError sometimes escaped
    // loadMore's try/catch to the error boundary, blanking the whole screen instead of showing
    // the inline "could not load more" banner.
    const prev = [run("a")];
    expect(() =>
      appendRunPage(prev, { nextCursor: null } as unknown as never),
    ).toThrow(UnexpectedResponseError);
    // The already-loaded page is untouched — the caller keeps showing what it had.
    expect(prev.map((r) => r.workflowId)).toEqual(["a"]);
  });
});

describe("runsLoadErrorMessage — the screen always says something", () => {
  it("names the shape mismatch, and points at the likely cause", () => {
    let thrown: unknown;
    try {
      readRunPage({ nextCursor: null });
    } catch (e) {
      thrown = e;
    }
    const msg = runsLoadErrorMessage(thrown, FALLBACK);
    expect(msg).not.toBe(FALLBACK);
    // It must name WHAT is wrong (the shape, and that `items` is what's missing) — "something
    // went wrong" and a blank screen are the same non-answer.
    expect(msg).toMatch(/shape/i);
    expect(msg).toMatch(/items/);
    // A version skew between this app and the API is the cause worth naming first.
    expect(msg).toMatch(/version/i);
  });

  it("keeps the auth message for a 401", () => {
    expect(runsLoadErrorMessage(new UnauthorizedError(), FALLBACK)).toMatch(
      /Not authenticated/,
    );
  });

  it("includes the status for an HTTP error", () => {
    expect(runsLoadErrorMessage(new HttpError("boom", 503), FALLBACK)).toMatch(
      /503/,
    );
  });

  it("falls back to the caller's message for anything else (a network drop)", () => {
    expect(
      runsLoadErrorMessage(new TypeError("failed to fetch"), FALLBACK),
    ).toBe(FALLBACK);
  });
});
