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
 *
 * DELAYED ROUTE STUBS ARE THE WHOLE TECHNIQUE. An instantly-fulfilled route gives no observable
 * window, so an assertion about a loading state cannot fail and the test is vacuous — it would
 * pass just as happily against the dead-window bug. The stubs below sleep before fulfilling, which
 * makes the intermediate stages real on the wire. The delays are LOWER bounds (a slow machine only
 * widens the window), which is what keeps this deterministic rather than a race.
 *
 * WHERE THE FAILING RUN COMES FROM. It is stubbed, not executed. A real failing Temporal run would
 * need a workflow seeded to fail, a poll to terminal, and would still hand us a run whose error
 * text, ctx and timing we do not control — and none of the five bugs above is about the
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
 * ORDERING INVARIANT: `graphDelayMs` must be strictly below `runDelayMs`. ENFORCED at the top of
 * `stubFixPath`, which throws — a rule that only a comment keeps is the kind of thing this file
 * exists to catch.
 *
 * The canvas mounts with SEED_NODES (start → approval → end), which COMPILE — so `currentGraph`
 * is already defined on the first render, before the real workflow has loaded. The build effect
 * therefore starts against the seed graph, and only re-runs against the real one because the
 * incoming workflow replaces the nodes and its cleanup releases the `builtFor` claim. If the run
 * reads finish FIRST, the claim is kept and the description is built against the seed canvas —
 * it comes out reading `Failed at node: "notify" (no longer in the workflow)`.
 *
 * That is a real latent race in the app (#998), not something these tests exist to
 * assert; every test here holds the realistic ordering — one round trip for the workflow versus
 * three sequential reads of the run — so it exercises the path a user actually takes.
 */
interface StubOptions {
  /** How long the canvas's workflow fetch takes. Must be below `runDelayMs` — see above. */
  graphDelayMs?: number;
  /** How long the run's state + executed-graph reads take. */
  runDelayMs?: number;
  /** How long the run's history takes. Added to `runDelayMs`, this is the `reading-run` window. */
  historyDelayMs?: number;
  /** The graph the canvas loads. Pass NON_COMPILING_GRAPH for the `blocked` case. */
  canvasGraph?: unknown;
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
    // Never zero by default: the run reads have to lose the race against the workflow load for
    // the description to be built against the workflow the user is looking at. See StubOptions.
    runDelayMs = 600,
    historyDelayMs = 0,
    canvasGraph = GRAPH,
    canvasVersion = 7,
    runVersion = 3,
    omitCurrentNodeId = false,
  } = opts;

  /**
   * ENFORCE the ordering the type's doc comment describes.
   *
   * A documented invariant that nothing checks is the exact shape of the bugs this file exists
   * to catch. Inverted, these tests do not fail loudly — they build the description against the
   * SEED canvas (#998), which produces a full, plausible instruction naming a step that "no
   * longer exists". Some assertions would then flake, and the rest would quietly stop testing
   * the path they claim to. Throwing here is the difference between a wrong test and a stopped
   * one.
   *
   * The message carries the RACE, not just the rule: whoever trips this has to understand why
   * the ordering matters before they can sensibly choose new numbers.
   */
  if (graphDelayMs >= runDelayMs) {
    throw new Error(
      `stubFixPath: graphDelayMs (${graphDelayMs}) must be strictly below runDelayMs (${runDelayMs}).\n` +
        "The canvas mounts with SEED_NODES, which COMPILE — so useFixFromRun starts building " +
        "against the seed graph on the first render, and only rebuilds against the real workflow " +
        "because the incoming graph tears the effect down and releases its `builtFor` claim. If " +
        "the run reads land FIRST, the claim is kept and the description is built against the " +
        'seed canvas (#998) — the prompt comes out reading `Failed at node: "…" (no longer in ' +
        "the workflow)`.\n" +
        "These tests hold the realistic ordering — one round trip for the workflow versus three " +
        "sequential reads of the run — so they exercise the path a user actually takes. Lower " +
        "graphDelayMs, or raise runDelayMs.",
    );
  }

  await page.route(apiPath(`/graphs/${KEY}`), (route) =>
    json(
      route,
      {
        workflowKey: KEY,
        name: "E2E fix-with-AI",
        version: canvasVersion,
        graph: canvasGraph,
      },
      graphDelayMs,
    ),
  );

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
  // NOT ASSERTED: the `loading-canvas` line ("Opening the workflow…"). It is unreachable (#998) from
  // this screen — the canvas mounts with SEED_NODES, which compile, so `hasGraph` is already true
  // on the first render and `fixStage` goes straight to `reading-run`. An assertion for it would
  // be one that can only ever fail, and `reading-run` guards the same thing (a stage line, up
  // from the first render after the click) on the path that actually runs.

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
  //      screen outright — which also makes RunView's own "this screen isn't unmounted" comment
  //      stale.
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
