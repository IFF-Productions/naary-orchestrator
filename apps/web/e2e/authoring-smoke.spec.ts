import { expect, type Page, type Route, test } from "@playwright/test";

/**
 * THE FIRST-RUN SMOKE PATH (#830, item 1).
 *
 * Three defects were reported in one breath — an invisible caret, `{{` not opening the
 * autocomplete, and Build-with-AI inventing connection ids — and all three shared a signature:
 * the product LOOKED like it worked and failed later or silently. None was catchable by a suite
 * asking "does the code do what it says", and two had already been "fixed" once, targeting the
 * wrong element and the wrong layer.
 *
 * So this file walks the journey a NEW USER actually makes, in one pass:
 *
 *     generate a workflow with AI → open a node → type `{{` → pick a ref → save → test-run a node
 *
 * and asserts the SYMPTOM a user would report at each stop, not the mechanism:
 *
 *   - the caret is a colour you can SEE on the app's own surface (computed style + contrast),
 *     not "the theme has a cm-cursor rule";
 *   - typing `{{` OPENS the completion list and the list NAMES the upstream node, not "a
 *     completion source is registered";
 *   - accepting a completion puts the reference IN THE FIELD, not "acceptCompletion is bound";
 *   - Save round-trips through the real API, and Test step returns the node's REAL output.
 *
 * A mechanism test passes while the user still can't see their cursor. That is precisely how the
 * caret bug survived its first fix.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT COVER — the third bug. `scrubInventedConnections` runs
 * SERVER-SIDE, between the model's answer and the SSE frames this spec stubs, so the payload here
 * is already post-scrub and there is nothing left to exercise. Nothing surfaces an unknown
 * connection id client-side either, so a browser assertion would be inventing app behaviour rather
 * than guarding it. It is covered where the check lives: `apps/api/test/graph-generator.service.spec.ts`
 * pins both the generate and the editStream paths. Said out loud so nobody reads this journey as
 * "all three are guarded here".
 *
 * WHAT IS STUBBED, AND WHY ONLY THAT. Exactly one hop: the builder session + its turn. It is the
 * only PAID, non-deterministic call on the path (a BYOK model call in CI is not acceptable), and
 * it is the only one whose response has to be pinned — the generated node ids ARE the reference
 * list the `{{` assertion reads, so a live model would make the rest of the journey unassertable.
 * Everything after it is real: the compile, `POST /graphs`, and the single-node test run all go to
 * the running stack. Stubbing those would make the last two steps assert nothing.
 *
 * No artificial delay on the stub (unlike `fix-with-ai.spec.ts`, which guards what the screen shows
 * WHILE it waits). This spec guards a LANDED graph, so an instant fulfil is strictly more
 * deterministic and the window it would open is one nothing here looks at.
 *
 * A FINDING THIS SPEC TURNED UP, recorded because it is the exact shape #830 is about. Every
 * assertion below was verified by a negative control (break it, watch it go red, revert), and the
 * control for "`{{` opens the list" is `activateOnTyping: false` — NOT removing the
 * `EditorView.inputHandler` that #828 added for this. With the handler intact and
 * `activateOnTyping` off, the list does not open; with the handler removed and `activateOnTyping`
 * on, it does. A probe inside the handler never logged: under Playwright's synthetic typing it is
 * never invoked, so what opens the list here is CodeMirror's own typing activation. This spec
 * therefore guards the SYMPTOM the user reported, which is the point — but nobody should read it
 * as proof that the #828 mechanism is what delivers it.
 *
 * The sharper version of that, which is about the PRODUCT and not about Playwright: the
 * configuration the whole journey passes under with the inputHandler neutered IS the pre-#828
 * configuration, and it passes. On today's dependencies the code shape that was reported as
 * broken is not broken. Either a dependency bump fixed it independently of #828, or the original
 * diagnosis named the wrong cause. Someone should go and find out which.
 *
 * THE FIELD EXERCISED is the SINGLE-LINE ExpressionField (httpRequest's URL), while both reports
 * said "text areas" — the multiline variant. Deliberate, and safe: `.cm-cursor` is themed by one
 * shared rule in `exprTheme` that both variants get, and every multiline candidate (agent =
 * prompt + systemPrompt, sendEmail = to/subject/text/html) renders SEVERAL `.cm-content` nodes,
 * which would make the locator below ambiguous — a worse trade than testing the shared rule once
 * on the unambiguous field.
 *
 * HONEST LIMIT ON THE CARET CHECK. It measures the computed `border-left-color` of `.cm-cursor`
 * against the painted surface behind it. That catches "invisible colour" — the bug that was
 * actually reported, twice — but NOT a caret that is zero-width, clipped by an ancestor, or
 * positioned off-screen. Those are real ways to lose a cursor and this does not see them.
 */

/** The workflow this journey saves as. Its own key: the suite runs `fullyParallel`, and
 *  global-setup already seeds `default` / `e2e-nodes` / `e2e-wait-webhook`. */
const FLOW_NAME = "E2E First Run";
const FLOW_KEY = "e2e-first-run";

/**
 * The graph the stubbed AI turn "generates".
 *
 * Three properties are load-bearing, not decoration:
 *   - `fetch` is an httpRequest, whose URL field is an ExpressionField — the "text area" both
 *     reports came from, and the only field type that has a caret and an autocomplete;
 *   - `fetch` has ANCESTORS (`seed`, `trigger`), because the completion source offers a node's
 *     ancestors — a node with none would make the `{{` assertion vacuous rather than green;
 *   - `seed` is a `set` node, which is PURE (@naary/dsl PURE_NODE_TYPES), so "test-run a node"
 *     runs in-process on the real API with no worker, no Temporal, no provider key and no egress.
 *     That is what makes the last step of the journey deterministic instead of merely nice.
 *
 * Ids are readable and share no prefix with each other, so the completion list has exactly one
 * option matching "seed".
 */
const SEEDED_TICKET = "NAARY-42";
const GENERATED_GRAPH = {
  startNodeId: "trigger",
  nodes: [
    { id: "trigger", type: "start" },
    {
      id: "seed",
      type: "set",
      config: { fields: { ticket: SEEDED_TICKET, status: "open" } },
    },
    {
      id: "fetch",
      type: "httpRequest",
      config: { method: "GET", url: "https://example.com/" },
    },
    { id: "done", type: "end" },
  ],
  edges: [
    { from: "trigger", to: "seed" },
    { from: "seed", to: "fetch" },
    { from: "fetch", to: "done" },
  ],
};

const SESSION_ID = "e2e-builder-session";
const now = "2026-01-01T00:00:00.000Z";

/** The session body both the open call and the post-turn thread refresh answer with. */
function sessionBody(withTurns: boolean) {
  return {
    id: SESSION_ID,
    status: "open",
    workflowKey: null,
    environmentId: null,
    title: FLOW_NAME,
    currentGraph: withTurns ? GENERATED_GRAPH : null,
    turns: withTurns
      ? [
          {
            id: "t1",
            role: "user",
            content: "Fetch a ticket and pass it on",
            createdAt: now,
          },
          {
            id: "t2",
            role: "assistant",
            content: "Built a 4-step flow.",
            costUsd: 0.01,
            options: [],
            createdAt: now,
          },
        ]
      : [],
    createdAt: now,
    updatedAt: now,
  };
}

/** One SSE frame, in the shape `createSseParser` reads. */
function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Stub the builder conversation — and ONLY it.
 *
 * ONE handler over the whole `/api/builder/` prefix rather than three routes, because Playwright
 * resolves routes most-recently-registered-first and a session-id pattern also matches the turns
 * URL beneath it; branching on the URL here makes the precedence explicit instead of positional.
 */
async function stubAiBuilder(page: Page): Promise<void> {
  await page.route("**/api/builder/**", async (route: Route) => {
    const url = route.request().url();
    if (url.endsWith("/turns")) {
      // The same frame protocol the real endpoint streams: meta, then each node and edge as it
      // lands (the canvas draws these live), then the authoritative validated `result`.
      const body =
        frame("meta", { name: FLOW_NAME }) +
        GENERATED_GRAPH.nodes.map((n) => frame("node", n)).join("") +
        GENERATED_GRAPH.edges.map((e) => frame("edge", e)).join("") +
        frame("result", { name: FLOW_NAME, graph: GENERATED_GRAPH });
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body,
      });
      return;
    }
    // POST /builder/sessions (open) and GET /builder/sessions/:id (the thread refresh the hook
    // makes after a successful turn — miss it and the panel keeps the optimistic turn only).
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(
        sessionBody(route.request().method() === "GET" ? true : false),
      ),
    });
  });
}

/** Parse a CSS colour into rgb; null when it isn't one we can read. */
function rgb(v: string): [number, number, number] | null {
  const m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** WCAG relative luminance — how light a colour reads, 0 (black) to 1 (white). */
function luminance([r, g, b]: [number, number, number]): number {
  const f = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

test("first run: generate with AI → `{{` → pick a ref → save → test a node", async ({
  page,
}) => {
  await stubAiBuilder(page);
  await page.goto("/app/canvas");

  await test.step("generate a workflow with AI", async () => {
    await page.getByRole("button", { name: "Build with AI" }).click();
    // "Start a new one" explicitly: the mode chip decides whether the turn amends the canvas or
    // replaces it, and a journey that begins with an ambiguous canvas is not a first run.
    await page.getByRole("radio", { name: "Start a new one" }).click();
    await page
      .getByPlaceholder(/Describe what you want to automate/)
      .fill("Fetch a ticket and pass it on");
    await page.getByRole("button", { name: "Send", exact: true }).click();

    // The SYMPTOM of a landed generation: the nodes are on the canvas. (Not "the request was
    // made" — the canvas silently keeping the old graph is exactly the failure worth catching.)
    await expect(page.locator(".react-flow__node")).toHaveCount(
      GENERATED_GRAPH.nodes.length,
    );
  });

  await test.step("open the generated HTTP node", async () => {
    await page.locator('.react-flow__node[data-id="fetch"]').click();
    await expect(page.getByText("Parameters", { exact: true })).toBeVisible();
  });

  const editor = page.locator(".cm-content").first();

  await test.step("the caret is a colour you can see", async () => {
    await expect(editor).toBeVisible();
    await editor.click();

    // `basicSetup` leaves drawSelection ON, which HIDES the native caret and draws `.cm-cursor`
    // as a border-left. The first fix set `caretColor` on `.cm-content` — styling the element
    // that is no longer drawn — so the cursor stayed CodeMirror's default black on a dark panel.
    const cursor = page.locator(".cm-cursor").first();
    await expect(cursor).toBeAttached();

    const { caret, surface } = await page.evaluate(() => {
      const c = document.querySelector(".cm-cursor") as HTMLElement | null;
      const content = document.querySelector(
        ".cm-content",
      ) as HTMLElement | null;
      // `.cm-content` is TRANSPARENT, so its own background-color is rgba(0,0,0,0) — reading it
      // directly would compare the caret against BLACK regardless of the real theme, and would be
      // accidentally right on a dark UI and plainly wrong on a light one. Walk up to whatever
      // actually paints behind the caret.
      const painted = (el: HTMLElement | null): string => {
        // Alpha exists ONLY in the 4-component form. Sniffing "the last comma-separated number"
        // reads the BLUE channel of `rgb(0, 0, 0)` as alpha=0 and skips a solid black background —
        // walking past the very surface being measured.
        const opaque = (bg: string): boolean => {
          if (!bg || bg === "transparent") return false;
          const parts = /\(([^)]*)\)/.exec(bg)?.[1].split(",") ?? [];
          return parts.length < 4 || Number(parts[3]) > 0;
        };
        for (let n: HTMLElement | null = el; n; n = n.parentElement) {
          const bg = getComputedStyle(n).backgroundColor;
          if (opaque(bg)) return bg;
        }
        return getComputedStyle(document.body).backgroundColor;
      };
      return {
        caret: c ? getComputedStyle(c).borderLeftColor : "",
        surface: painted(content),
      };
    });

    const caretRgb = rgb(caret);
    expect(caretRgb, `caret border-left-color was "${caret}"`).not.toBeNull();

    // The real complaint was "I can't see it", so measure CONTRAST against what it sits on —
    // asserting a specific hex would pass on a theme change that made it invisible again.
    const surfaceRgb = rgb(surface);
    expect(
      surfaceRgb,
      `could not read the surface behind the caret ("${surface}")`,
    ).not.toBeNull();
    const lc = luminance(caretRgb as [number, number, number]);
    const ls = luminance(surfaceRgb as [number, number, number]);
    const contrast = (Math.max(lc, ls) + 0.05) / (Math.min(lc, ls) + 0.05);
    expect(
      contrast,
      `caret ${caret} on ${surface} — only ${contrast.toFixed(1)}:1, that's the "no caret" report`,
    ).toBeGreaterThan(3);
  });

  await test.step("`{{` opens the reference list, and it names the upstream node", async () => {
    // Type at the END of the seeded URL, the way a user extends one.
    await editor.press("ControlOrMeta+End");
    // CodeMirror's `activateOnTyping` only fires on WORD characters, and `{` is not one — so the
    // completion source was correct and nothing ever opened it. Assert the list APPEARS.
    await page.keyboard.type("{{");
    const list = page.locator(".cm-tooltip-autocomplete");
    await expect(list).toBeVisible({ timeout: 4000 });

    // …and that it offers the REAL upstream node. A list that opens empty (or lists only
    // `__input`) is the same dead end from the user's side as a list that never opened.
    await expect(
      list.getByRole("option", { name: "seed", exact: true }),
    ).toBeVisible();
  });

  await test.step("picking a ref writes it into the field", async () => {
    await page
      .locator(".cm-tooltip-autocomplete")
      .getByRole("option", { name: "seed", exact: true })
      .click();
    await page.keyboard.type("}}");
    // The symptom: the reference is IN THE FIELD. A completion that highlights but never applies
    // leaves the user typing node ids by hand, which is the thing autocomplete exists to stop.
    await expect(editor).toHaveText("https://example.com/{{seed}}");
  });

  await test.step("save the workflow", async () => {
    await page.getByPlaceholder("Workflow name").fill(FLOW_NAME);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText(/Saved as/)).toBeVisible();
  });

  await test.step("test-run a node and see its real output", async () => {
    await page.locator('.react-flow__node[data-id="seed"]').click();
    await page.getByRole("button", { name: /Test step/ }).click();
    // The REAL round trip: the API reads `seed` out of the graph just saved, runs it (a pure node,
    // in-process) and returns its output. Asserting the seeded value — not just "a panel opened" —
    // is what makes this a test of the run rather than of the button.
    await expect(page.getByText("Output ready")).toBeVisible({
      timeout: 20_000,
    });
    // The OUTPUT ROW, addressed by the reference it offers to insert — not `getByText` on the
    // value, which also matches the config panel's JSON field showing the same literal. A row here
    // means the run returned the field AND the dock turned it into something referenceable, which
    // is what the next step of authoring actually needs.
    const ticketRow = page.getByTitle(
      "Drag into a parameter to insert {{ seed.ticket }}",
    );
    await expect(ticketRow).toBeVisible();
    await expect(ticketRow).toContainText(SEEDED_TICKET);
  });
});
