import { expect, type Page, type Route, test } from "@playwright/test";

/**
 * "Fix with AI" (`?fix=<runId>`) — the only guard this path has.
 *
 * The flow: a run fails → the user presses "Fix with AI" on the run detail → the canvas opens at
 * `?fix=<runId>` → the AI panel opens and fills itself with a description of the failure.
 *
 * WHY THIS FILE EXISTS. Every bug below shipped, and every one of them was invisible to
 * `tsc --noEmit` and to the unit suite — they are all bugs about WHAT THE SCREEN SHOWS WHILE IT IS
 * WAITING, or about state surviving a navigation, neither of which a pure-function test can see.
 * They were caught by a throwaway Playwright harness that was never committed, so the next
 * regression had nothing to hit. This is that harness, kept.
 *
 *   1. A DEAD WINDOW. The panel opened on COMPLETION rather than on arrival, so the canvas
 *      appeared and nothing said a description was coming — the button read as broken. Fixed with
 *      the `FixStage` enum + the arrival effect (useFixFromRun). (Not counted here: the enum is
 *      right there to be read, and a number in prose goes stale the next time a stage is added.)
 *   2. TYPING DURING THE WAIT WAS SILENTLY OVERWRITTEN when the description landed. Fixed with
 *      `readOnly` — deliberately NOT `disabled`, which drops the field out of the tab order and
 *      out of reach of a screen reader. The test below has to tell those two apart, so it asserts
 *      focusability as well as rejected input.
 *   3. A STAGE THAT PROMISES SOMETHING THAT NEVER ARRIVES. `blocked` is terminal, not a wait, and
 *      its copy must not claim "there's no workflow on the canvas" when a workflow is visibly
 *      there and simply fails to compile.
 *   4. STATE LEAKING ACROSS RUNS. The execution log's open payload rows are keyed by node id,
 *      which two runs of the SAME workflow share, so a row opened on one run came back open on
 *      the next (RunLog's `events === null` reset). See that test for what it can and cannot
 *      catch — the leak is now guarded three times over, and this pins the property, not one
 *      of the three mechanisms.
 *   5. DUPLICATE ACCESSIBLE NAMES. The step timeline and the execution log each carry a button
 *      per step, so one step's name matches two buttons that do different things. Fixed by naming
 *      BOTH lists as ARIA groups — not by tightening a selector, which would have left the screen
 *      ambiguous for anyone navigating it by name.
 *   6. THE DESCRIPTION BUILT AGAINST THE SEED CANVAS (#998). The canvas mounts with SEED_NODES,
 *      which COMPILE, so the build effect could start before the workflow had loaded and — if the
 *      run reads won the race — finish against the seed. The prompt then named a step "no longer
 *      in the workflow" beneath a banner saying the fix applied to the workflow on screen: a
 *      confident falsehood, in the feature that exists to prevent one. Fixed by waiting for the
 *      workflow fetch to SETTLE (`canvasLoaded`) rather than for a graph to compile — which also
 *      made the `loading-canvas` stage reachable, having been dead for the same reason.
 *   7. THE SAME DESCRIPTION, VIA A FAILED OPEN (#1006). Waiting for the workflow fetch to SETTLE
 *      closed the race but not the case where it settles by FAILING: the nodes are never replaced,
 *      so the seed is still on the canvas, compiling, and "settled" read as "this is the
 *      workflow". Fixed by making the load a three-state value — loading / loaded / failed — so
 *      failure stays terminal (no spinner) without being mistaken for a loaded workflow, and by
 *      giving `blocked` a third sentence, since the two it had are both false about a canvas that
 *      is neither empty nor broken.
 *
 * DELAYED ROUTE STUBS ARE THE WHOLE TECHNIQUE. An instantly-fulfilled route gives no observable
 * window, so an assertion about a loading state cannot fail and the test is vacuous — it would
 * pass just as happily against the dead-window bug. The stubs below sleep before fulfilling, which
 * makes the intermediate stages real on the wire. The delays are LOWER bounds (a slow machine only
 * widens the window), which is what keeps this deterministic rather than a race.
 *
 * WHERE THE FAILING RUN COMES FROM. It is stubbed, not executed. A real failing Temporal run would
 * need a workflow seeded to fail, a poll to terminal, and would still hand us a run whose error
 * text, ctx and timing we do not control — and none of the bugs above is about the
 * orchestrator producing a failure correctly. What they are about is the SPA's handling of a
 * failed run's data, so the run's data is the input, and stubbing it is what makes the error text,
 * the executed-version drift, and above all the RESPONSE TIMING assertable at all. The stubs are
 * shaped from the same API types the client parses (ExecutionState / RunEvent / NamedGraph), so a
 * response-shape change still breaks these tests.
 *
 * Every response this spec depends on is stubbed per-page, so it holds no shared server state and
 * is safe under `fullyParallel: true` and CI's retry.
 */

/** The workflow the fix targets. Deliberately NOT one of global-setup's seeds — every response
 *  for it is stubbed, so seeding one would only invite the two to disagree. */
const KEY = "e2e-fix-with-ai";
/** The failed run whose failure is described, and the run a resume produces from it. */
const RUN = "e2e-fix-run-a";
const RESUMED_RUN = "e2e-fix-run-b";
/**
 * A string that can only have arrived by way of the run's HISTORY.
 *
 * Asserting the textarea is merely non-empty would pass on a broken chain: with a
 * wrongly-shaped history `errorDetail` is null and `buildFixInstruction` still returns a full
 * instruction reading "(no error message was recorded)". This one token proves the whole path —
 * run state read → history read → historyTimes → buildFixInstruction → setAiPrompt → render.
 */
const SENTINEL = "E2E_FIX_SENTINEL_upstream_returned_503";
/** The step that died. Its `__name` is what both step lists label their button with (bug 5). */
const FAILED_NODE = "notify";
const FAILED_LABEL = "Notify on-call";
/** A step that SUCCEEDED — the one whose payload row is opened in the leak test (bug 4). */
const OK_NODE = "lookup";
const OK_LABEL = "Look up the ticket";

/** The graph on the canvas (and, at an older version, the one the run executed). */
const GRAPH = {
  startNodeId: "trigger",
  nodes: [
    {
      id: "trigger",
      type: "start",
      config: { __name: "Ticket webhook", sampleInput: { ticket: "NAARY-42" } },
    },
    {
      id: OK_NODE,
      type: "httpRequest",
      config: {
        __name: OK_LABEL,
        method: "GET",
        url: "https://example.invalid/tickets/{{ trigger.ticket }}",
      },
    },
    {
      id: FAILED_NODE,
      type: "httpRequest",
      config: {
        __name: FAILED_LABEL,
        method: "POST",
        url: "https://example.invalid/page/{{ lookup.body.oncall }}",
      },
    },
    { id: "done", type: "end" },
  ],
  edges: [
    { from: "trigger", to: OK_NODE },
    { from: OK_NODE, to: FAILED_NODE },
    { from: FAILED_NODE, to: "done" },
  ],
};

/**
 * The same workflow with a SECOND trigger — `compileGraph` rejects it with "Multiple entry
 * nodes …", so the canvas has nodes on it and no compiled graph. That is the state bug 3 is
 * about: visibly a workflow, and nothing the description can be built against.
 */
const NON_COMPILING_GRAPH = {
  ...GRAPH,
  nodes: [
    ...GRAPH.nodes,
    {
      id: "second-trigger",
      type: "start",
      config: { __name: "Stray trigger" },
    },
  ],
};

/** Fixed timestamps — a run's rendered times must not depend on when the suite runs. */
const T0 = "2026-07-24T09:00:00.000Z";
const T1 = "2026-07-24T09:00:04.000Z";

/** The failed run's state: `notify` died, `lookup` succeeded before it. */
const RUN_STATE = {
  status: "failed",
  currentNodeId: FAILED_NODE,
  ctx: {
    __input: { ticket: "NAARY-42" },
    [OK_NODE]: { httpStatus: 200, body: { oncall: "ops-rota" } },
  },
  executedNodeIds: ["trigger", OK_NODE],
  nodeTimes: {
    trigger: { s: 1_753_347_600_000, f: 1_753_347_600_120 },
    [OK_NODE]: { s: 1_753_347_600_120, f: 1_753_347_601_400 },
    [FAILED_NODE]: { s: 1_753_347_601_400, f: 1_753_347_604_000 },
  },
};

/** The run's curated history. The `error` event is where the sentinel lives, and its presence
 *  also stops `useRunHistory` polling (it treats error/completed/continued as the closing event). */
const RUN_HISTORY = [
  { id: 1, kind: "started", label: "Run started", at: T0 },
  {
    id: 2,
    kind: "error",
    label: "Activity task failed",
    at: T1,
    detail: `${SENTINEL}: POST https://example.invalid/page/ops-rota returned 503`,
  },
];

/** The run a resume produces — same workflow, so it shares every node id (which is what makes
 *  bug 4 possible at all). Its log carries a distinct label so the test can wait for THIS run's
 *  events rather than asserting into the gap where the previous run's log has been cleared. */
const RESUMED_STATE = {
  status: "completed",
  currentNodeId: "done",
  ctx: {
    __input: { ticket: "NAARY-42" },
    [OK_NODE]: { httpStatus: 200, body: { oncall: "ops-rota" } },
    [FAILED_NODE]: { httpStatus: 202 },
  },
  executedNodeIds: ["trigger", OK_NODE, FAILED_NODE, "done"],
  nodeTimes: RUN_STATE.nodeTimes,
};
const RESUMED_HISTORY = [
  { id: 1, kind: "started", label: "Run started (resumed)", at: T0 },
  { id: 2, kind: "completed", label: "E2E_FIX_RESUMED_RUN_FINISHED", at: T1 },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Fulfil a route as JSON, after `delayMs`. The delay is the point — see the header. */
async function json(route: Route, body: unknown, delayMs = 0): Promise<void> {
  if (delayMs > 0) await sleep(delayMs);
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

/** Anchored so the patterns below are mutually exclusive and route-registration order can't
 *  matter: `…/executions/<id>` must not also swallow `…/executions/<id>/history`. */
function apiPath(suffix: string): RegExp {
  return new RegExp(`/api${suffix}(\\?.*)?$`);
}

/**
 * THE TWO DELAYS ARE INDEPENDENT — which is itself an assertion (bug 6).
 *
 * They used to be constrained: `graphDelayMs` had to stay strictly below `runDelayMs`, enforced by
 * a throw, because the canvas mounts with SEED_NODES (start → approval → end) and those COMPILE.
 * `currentGraph` was therefore defined on the first render, before the real workflow had loaded,
 * and the build effect started against the seed graph — recovering only because the incoming
 * workflow replaced the nodes and the teardown released the `builtFor` claim. Land the run reads
 * first and the claim was kept: the description came out describing the SEED canvas, reading
 * `Failed at node: "notify" (no longer in the workflow)` under a banner naming the workflow on
 * screen.
 *
 * `useFixFromRun` now waits for `canvasLoad === "loaded"` — the workflow fetch having SUCCEEDED —
 * rather than for whatever happens to compile, so neither ordering can build against the seed. The
 * throw is gone with the race, and the inverted ordering has its own test below. (Waiting for the
 * fetch to merely SETTLE was the intermediate step, and `graphFails` below is the case that showed
 * why it was not enough: a settled failure leaves the same seed behind — #1006.)
 */
interface StubOptions {
  /** How long the canvas's workflow fetch takes. Free of `runDelayMs` since #998 — see above. */
  graphDelayMs?: number;
  /** How long the run's state + executed-graph reads take. */
  runDelayMs?: number;
  /** How long the run's history takes. Added to `runDelayMs`, this is the `reading-run` window. */
  historyDelayMs?: number;
  /** The graph the canvas loads. Pass NON_COMPILING_GRAPH for the `blocked` case. */
  canvasGraph?: unknown;
  /**
   * FAIL the workflow read instead of fulfilling it — bug 7.
   *
   * A different stub SHAPE, not another delay: the route answers 500 (after `graphDelayMs`, so the
   * `loading-canvas` window is still real), the api client throws, and `CanvasPage` sets its status
   * line without ever replacing the nodes. The canvas is left holding SEED_NODES, which is the
   * whole point of the case. 500 rather than 401 — `UnauthorizedError` is handled globally and
   * would take the page somewhere else entirely — and rather than `route.abort()`, which is a
   * network-layer failure the app never sees from a real server.
   */
  graphFails?: boolean;
  /** The canvas's saved version vs the version the run executed — the drift banner compares them. */
  canvasVersion?: number;
  runVersion?: number;
  /** Drop the failed-node id from the run state — the "nothing specific to describe" path. */
  omitCurrentNodeId?: boolean;
}

/**
 * Stub every response the fix path reads, for BOTH runs.
 *
 * Registered before `page.goto` (a handler added afterwards would miss the first request the
 * canvas makes) and matched on the WEB origin: the SPA's api client is based at the relative
 * "/api", which nginx/vite proxies — the browser never addresses the API's own port, so a
 * pattern written against `E2E_API_BASE` would match nothing and every stub would silently
 * no-op while the test passed against real data.
 */
async function stubFixPath(page: Page, opts: StubOptions = {}): Promise<void> {
  const {
    graphDelayMs = 0,
    // The realistic ordering, kept as the default: one round trip for the workflow versus three
    // sequential reads of the run. Non-zero so the `reading-run` window is real on the wire — an
    // instantly-fulfilled route gives nothing to observe (see the header). Correctness no longer
    // depends on it; the inverted ordering has its own test.
    runDelayMs = 600,
    historyDelayMs = 0,
    canvasGraph = GRAPH,
    canvasVersion = 7,
    runVersion = 3,
    omitCurrentNodeId = false,
    graphFails = false,
  } = opts;

  await page.route(apiPath(`/graphs/${KEY}`), async (route) => {
    if (graphFails) {
      if (graphDelayMs > 0) await sleep(graphDelayMs);
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ message: "E2E: the workflow read failed" }),
      });
      return;
    }
    await json(
      route,
      {
        workflowKey: KEY,
        name: "E2E fix-with-AI",
        version: canvasVersion,
        graph: canvasGraph,
      },
      graphDelayMs,
    );
  });

  const state = omitCurrentNodeId
    ? { ...RUN_STATE, currentNodeId: "" }
    : RUN_STATE;
  await page.route(apiPath(`/executions/${RUN}`), (route) =>
    json(route, state, runDelayMs),
  );
  await page.route(apiPath(`/executions/${RUN}/graph`), (route) =>
    json(
      route,
      { graph: GRAPH, version: runVersion, workflowKey: KEY },
      runDelayMs,
    ),
  );
  await page.route(apiPath(`/executions/${RUN}/history`), (route) =>
    json(route, RUN_HISTORY, historyDelayMs),
  );

  await page.route(apiPath(`/executions/${RESUMED_RUN}`), (route) =>
    json(route, RESUMED_STATE),
  );
  await page.route(apiPath(`/executions/${RESUMED_RUN}/graph`), (route) =>
    json(route, { graph: GRAPH, version: canvasVersion, workflowKey: KEY }),
  );
  await page.route(apiPath(`/executions/${RESUMED_RUN}/history`), (route) =>
    json(route, RESUMED_HISTORY),
  );
}

/**
 * The AI panel's prompt box.
 *
 * Located as "the page's only textarea", which holds because the canvas's other textareas all
 * live behind something that is shut here (the node config modal, the pin editor, the run-input
 * panel). The count assertion states that dependency out loud, so a future textarea makes this
 * fail with "expected 1, got 2" rather than with a mysterious strict-mode violation.
 */
async function promptBox(page: Page) {
  const box = page.locator("textarea");
  await expect(box).toHaveCount(1);
  return box;
}

test("fix: the AI panel opens on ARRIVAL and names each wait, not just the result", async ({
  page,
}) => {
  // The wait made observable. Without these delays the stage would come and go inside one frame
  // and the assertion below could not fail — which is the same as not making it.
  await stubFixPath(page, {
    graphDelayMs: 700,
    runDelayMs: 1200,
    historyDelayMs: 1200,
  });
  await page.goto(`/app/canvas?key=${KEY}&fix=${RUN}`);

  // BUG 1. The panel is up, and SAYING something, long before the description exists. The stage
  // line renders only DURING the wait, so a panel that opened on completion could not satisfy
  // this late — it would never render the line at all.
  await expect(page.getByText(`Describing the failure from run`)).toBeVisible();
  await expect(
    page.getByText(/^Reading the run — the error, the step that failed/),
  ).toBeVisible();
  // The `loading-canvas` line ("Opening the workflow…") precedes this one and is asserted in the
  // slow-workflow test below, where its window is 1.2s wide. Not asserted here: it closes as soon
  // as `/graphs` lands, and pinning a 700ms window in two places buys nothing.

  // …and the wait ends with the description actually in the box. The sentinel is what proves the
  // run's history was read rather than an empty instruction being rendered (see its declaration).
  const box = await promptBox(page);
  await expect(box).toHaveValue(new RegExp(SENTINEL));
  await expect(box).toHaveValue(new RegExp(`Failed at node: "${FAILED_NODE}"`));

  // Terminal: the progress line does not survive the description landing.
  await expect(page.getByText(/^Reading the run/)).toHaveCount(0);
  // The banner switches from "…" to pointing at the box only once there IS something in it.
  await expect(
    page.getByText("Read it below and edit anything before generating."),
  ).toBeVisible();

  // The disclosure of what leaves the tenant NAMES the steps whose output is included.
  await expect(page.getByText(OK_NODE, { exact: true })).toBeVisible();
  // A fix is a CHANGE to this workflow, chosen on arrival — not left on whatever the panel
  // last had, which would silently point Generate at "replace the canvas".
  await expect(
    page.getByRole("radio", { name: "Change this workflow" }),
  ).toHaveAttribute("aria-checked", "true");
});

test("fix: a SLOW workflow load still describes the failure against the workflow, not the seed canvas", async ({
  page,
}) => {
  // BUG 6, and the ordering the old invariant forbade: the run reads come back FIRST — instantly —
  // and the workflow takes 1.2s. In production this is one slow `/graphs` response; here it is the
  // race made deterministic. Before the fix the description was built on the first render, against
  // the SEED canvas (start → approval → end), and the finished claim survived the real workflow
  // landing.
  await stubFixPath(page, { graphDelayMs: 1200, runDelayMs: 0 });
  await page.goto(`/app/canvas?key=${KEY}&fix=${RUN}`);

  // The wait is now NAMED rather than skipped past. `loading-canvas` was unreachable for exactly
  // the reason the race existed — the seed graph compiles, so `hasGraph` was true on render 1 and
  // the stage went straight to `reading-run` — so this line is the visible half of the fix.
  await expect(page.getByText("Opening the workflow…")).toBeVisible();

  const box = await promptBox(page);
  // TWO-SIDED, because either half alone can pass on a broken build. The negative is the exact
  // falsehood the seed canvas produces; the positive is something ONLY the real workflow can say —
  // the seed has no `notify` node, so it can neither name its type nor quote its URL. Together
  // they also rule out an empty or half-built instruction.
  await expect(box).toHaveValue(
    new RegExp(`Failed at node: "${FAILED_NODE}" \\(type: httpRequest\\)`),
  );
  await expect(box).toHaveValue(/https:\/\/example\.invalid\/page\//);
  await expect(box).not.toHaveValue(/no longer in the workflow/);

  // And the banner still agrees with the box: the fix applies to the version on the canvas, which
  // is the claim that was false while the description described a different graph.
  await expect(
    page.getByText(/That run used v3; this workflow is now v7/),
  ).toBeVisible();
});

test("fix: the prompt box is read-only while the description is being written — not disabled", async ({
  page,
}) => {
  // A wide `reading-run` window on purpose: this test types into the box mid-wait, and the
  // window has to comfortably outlast a focus + keystrokes + two assertions.
  await stubFixPath(page, { runDelayMs: 1000, historyDelayMs: 6000 });
  await page.goto(`/app/canvas?key=${KEY}&fix=${RUN}`);

  const box = await promptBox(page);
  await expect(
    page.getByText(/^Reading the run — the error, the step that failed/),
  ).toBeVisible();

  // BUG 2, and the distinction that made it a real fix rather than a plausible one:
  //   `disabled` would ALSO stop the overwrite — and would take the field out of the tab order
  //   and out of reach of a screen reader. So the guard is not "input is rejected"; it is
  //   "input is rejected AND the field is still enabled and still focusable".
  //
  // READ IMMEDIATELY, NOT THROUGH `expect().toBeEnabled()`. A web-first assertion RETRIES, so on
  // a `disabled` box it would simply wait out the read-only window, see the field enabled once
  // the description landed, and pass — the exact regression this test exists for, sailing
  // through. These are one-shot reads taken while the stage line above is up.
  expect(
    await box.isDisabled(),
    "the prompt box must stay in the tab order while it waits — readOnly, never disabled",
  ).toBe(false);
  expect(
    await box.isEditable(),
    "the prompt box must reject input while the description is being written into it",
  ).toBe(false);
  await box.focus();
  expect(
    await box.evaluate((el) => el === document.activeElement),
    "a disabled field cannot take focus — this is what separates readOnly from disabled",
  ).toBe(true);
  await box.pressSequentially("typing while it loads");
  expect(await box.inputValue()).toBe("");

  // …and the moment the description lands the box is editable again, with the user's own text
  // no longer at risk of being replaced under them.
  await expect(box).toHaveValue(new RegExp(SENTINEL));
  await expect(box).toBeEditable();
  await box.fill("Actually, just retry it twice.");
  await expect(box).toHaveValue("Actually, just retry it twice.");
});

test("fix: a canvas that doesn't COMPILE is told so — not told there's no workflow", async ({
  page,
}) => {
  // The workflow loads fine and is visibly on the canvas; it just has two triggers, so
  // `compileGraph` refuses it and there is nothing for the description to be built against.
  // The run reads are held back so the non-compiling workflow is what the panel is looking at
  // when it decides — see StubOptions.
  await stubFixPath(page, {
    canvasGraph: NON_COMPILING_GRAPH,
    runDelayMs: 1500,
  });
  await page.goto(`/app/canvas?key=${KEY}&fix=${RUN}`);

  // BUG 3. `blocked` is terminal, so it must ANSWER. It names the compile error, which is the
  // thing the user can act on.
  await expect(
    page.getByText(/The canvas doesn't compile — Multiple entry nodes/),
  ).toBeVisible();

  // THE ASSERTION THAT IS ACTUALLY THE GUARD: the other blocked copy must not be used here. A
  // workflow is plainly on the canvas — the nodes are rendered — so "there's no workflow on the
  // canvas" would be a confident falsehood about something the user is looking at. Without this
  // negative, collapsing the two branches back into one would pass.
  await expect(
    page.getByText(/There's no workflow on the canvas to change/),
  ).toHaveCount(0);

  // Terminal, not a wait: no progress line is left promising a description that isn't coming,
  // and nothing lands in the box afterwards.
  await expect(page.getByText(/^Reading the run/)).toHaveCount(0);
  await expect(await promptBox(page)).toHaveValue("");
  // The two trigger nodes really are on the canvas — which is what makes the copy above matter.
  await expect(page.locator(".react-flow__node")).toHaveCount(
    NON_COMPILING_GRAPH.nodes.length,
  );
});

test("fix: a workflow that FAILS to open is said so — the seed canvas is never described as it", async ({
  page,
}) => {
  // BUG 7. The workflow read fails, so `CanvasPage` writes a status line and stops — the nodes are
  // never replaced and the canvas keeps SEED_NODES, which COMPILE. The run reads land instantly,
  // so a settled/not-settled flag hands that seed to the description as though it were the
  // workflow. The 400ms is what makes `loading-canvas` a real window rather than a frame.
  await stubFixPath(page, {
    graphFails: true,
    graphDelayMs: 400,
    runDelayMs: 0,
  });
  await page.goto(`/app/canvas?key=${KEY}&fix=${RUN}`);

  // The wait is real first — a failed open is not instant, and this is the state it comes out of.
  await expect(page.getByText("Opening the workflow…")).toBeVisible();

  // `blocked`, with the sentence that is TRUE of this canvas. The failure is terminal, so it has
  // to answer rather than spin.
  // `blocked`, with the sentence that is TRUE of this canvas — and the SYNC POINT for the
  // assertions below: it can only appear once the load has settled, which is exactly when the
  // seed-built description used to land in the box. Asserting the box before it would pass
  // vacuously on the bug, since the box is empty until then either way.
  await expect(
    page.getByText(/That workflow couldn't be opened/),
  ).toBeVisible();

  // THE ASSERTIONS THAT FAIL ON THE BUG, not merely on the missing copy. Before the fix the
  // description was built against the seed and landed in the box, reading
  // `Failed at node: "notify" (no longer in the workflow)` — the exact falsehood #998 removed from
  // the race, arriving by a different door.
  const box = await promptBox(page);
  await expect(box).toHaveValue("");
  await expect(box).not.toHaveValue(/no longer in the workflow/);

  // Neither of the other two `blocked` sentences may be used here, and each is false for its own
  // reason: three nodes are visibly on the canvas, and they compile fine. Without these negatives,
  // collapsing this branch back into either of them would pass.
  await expect(
    page.getByText(/There's no workflow on the canvas to change/),
  ).toHaveCount(0);
  await expect(page.getByText(/The canvas doesn't compile/)).toHaveCount(0);

  // Terminal: nothing is left promising a description that isn't coming.
  await expect(page.getByText(/^Reading the run/)).toHaveCount(0);
  await expect(page.getByText("Opening the workflow…")).toHaveCount(0);

  // What makes the copy above matter: the SEED graph really is rendered — start → approval → end —
  // so a sentence claiming there is nothing on the canvas would be false about what is on screen.
  await expect(page.locator(".react-flow__node")).toHaveCount(3);
  // …and the screen's own report of the failed open is still there, unchanged by any of this.
  await expect(
    page.getByText(`Couldn't open workflow '${KEY}'.`),
  ).toBeVisible();
});

test("fix: a run that executed an older version says so", async ({ page }) => {
  await stubFixPath(page, { runVersion: 3, canvasVersion: 7 });
  await page.goto(`/app/canvas?key=${KEY}&fix=${RUN}`);

  // Drift is derived at RENDER against the version the canvas has now — computed inside the
  // fetch effect it would close over a still-null version and the warning would simply never
  // appear, with nothing looking broken. This is the assertion that would notice.
  await expect(
    page.getByText(/That run used v3; this workflow is now v7/),
  ).toBeVisible();
});

test("fix: a run with no recorded failed step ends with a reason, not a spinner", async ({
  page,
}) => {
  await stubFixPath(page, { omitCurrentNodeId: true, runDelayMs: 800 });
  await page.goto(`/app/canvas?key=${KEY}&fix=${RUN}`);

  // A stated reason IS an outcome — the stage ends, the box stays empty, and the panel says what
  // to do instead. (The other half of bug 1: every path out of the wait has to terminate.)
  await expect(
    page.getByText(/doesn't record which step failed/),
  ).toBeVisible();
  await expect(page.getByText(/^Reading the run/)).toHaveCount(0);
  await expect(await promptBox(page)).toHaveValue("");
  // "Read it below" is asserted against the BOX, not the stage — there is nothing below to read.
  await expect(
    page.getByText("Read it below and edit anything before generating."),
  ).toHaveCount(0);
});

test("run detail: 'Fix with AI' carries the failed run into the canvas", async ({
  page,
}) => {
  await stubFixPath(page, { runDelayMs: 800, historyDelayMs: 600 });
  await page.goto(`/app/runs/${RUN}`);

  // The entry point itself: offered on a system failure, and only with a failed step to talk
  // about. Clicking it is the whole hand-off — the canvas key and the run id in one URL.
  await page.getByRole("button", { name: "Fix with AI" }).click();
  await expect(page).toHaveURL(new RegExp(`key=${KEY}.*fix=${RUN}`));
  await expect(page.getByText("Describing the failure from run")).toBeVisible();
  await expect(await promptBox(page)).toHaveValue(new RegExp(SENTINEL));
});

test("run detail: the step timeline and the execution log are each named, so a step's button is unambiguous", async ({
  page,
}) => {
  await stubFixPath(page);
  await page.goto(`/app/runs/${RUN}`);

  // BUG 5. Both lists carry a button for the same step, so the bare name is genuinely ambiguous —
  // this is the state that used to break a locator, and it is expected to stay true.
  const ambiguous = page.getByRole("button", {
    name: new RegExp(FAILED_LABEL),
  });
  await expect(ambiguous).toHaveCount(2);

  // The fix was to NAME BOTH LISTS as ARIA groups rather than to tighten a selector: the
  // disambiguation has to exist on the screen (for anyone navigating it by name), not only in
  // the test. Each group resolving to exactly one button is what says it does.
  await expect(
    page
      .getByRole("group", { name: "Step timeline" })
      .getByRole("button", { name: new RegExp(FAILED_LABEL) }),
  ).toHaveCount(1);
  await expect(
    page
      .getByRole("group", { name: "Execution log" })
      .getByRole("button", { name: new RegExp(FAILED_LABEL) }),
  ).toHaveCount(1);
});

test("run detail: an open payload row does not follow you to the next run of the same workflow", async ({
  page,
}) => {
  await stubFixPath(page);
  // Resume-from-failed-node is the realistic way to reach a SECOND run of this workflow without
  // leaving the screen, and the navigation stays inside the SPA — a `page.goto` would be a fresh
  // document, where nothing could have leaked in the first place.
  //
  // WHAT THIS CAN AND CANNOT CATCH, stated because the difference matters. The leak is currently
  // prevented THREE times over, and deleting any one of them leaves this test green:
  //   1. RunLog resets `open` when `events` goes null (the fix this bug produced);
  //   2. RunView clears `graph` on an id change, which unmounts the whole pane holding the log;
  //   3. AppShell keys the routed screen by `pathname`, so a run→run navigation remounts the
  //      screen outright — which is why RunView's clears no longer carry the reason they were
  //      written with, and now say so.
  // Verified by removing them one at a time: only with all three gone does the row come back
  // open. So this guards the OBSERVABLE property — no row is pre-opened on the next run — rather
  // than pinning any one mechanism, and it turns red the moment the property genuinely breaks.
  await page.route(apiPath(`/executions/${RUN}/resume-eligibility`), (route) =>
    json(route, { resumable: true, failedNodeId: FAILED_NODE }),
  );
  await page.route(apiPath(`/executions/${RUN}/resume`), (route) =>
    json(route, { workflowId: RESUMED_RUN }),
  );
  await page.goto(`/app/runs/${RUN}`);

  const logRow = page
    .getByRole("group", { name: "Execution log" })
    .getByRole("button", { name: new RegExp(OK_LABEL) });
  await logRow.click();
  await expect(logRow).toHaveAttribute("aria-expanded", "true");
  await expect(
    page.getByText(/this step's settings, filled in with this run's data/),
  ).toBeVisible();

  // Same workflow, so the same node ids — which is exactly why the open-row set could leak.
  await page.getByRole("button", { name: "Resume from failed node" }).click();
  await expect(page).toHaveURL(new RegExp(`/app/runs/${RESUMED_RUN}$`));

  // BUG 4. Assert only once the NEW run's log has arrived: right after the navigation the log is
  // null and the payload is hidden no matter what, so asserting into that gap would pass on the
  // bug. This label comes from the resumed run's history alone.
  await expect(page.getByText("E2E_FIX_RESUMED_RUN_FINISHED")).toBeVisible();
  await expect(
    page
      .getByRole("group", { name: "Execution log" })
      .getByRole("button", { name: new RegExp(OK_LABEL) }),
  ).toHaveAttribute("aria-expanded", "false");
  await expect(
    page.getByText(/this step's settings, filled in with this run's data/),
  ).toHaveCount(0);
});
