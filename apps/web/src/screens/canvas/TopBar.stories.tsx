/**
 * The canvas top bar — and specifically the ISSUES PILL at phone width, which had no story and
 * was not rendered there at all.
 *
 * Reported as: a run failed on an unresolved input, the run detail named the node and the field,
 * and the canvas offered no way to see or fix it. The lint had found it — `lintBindings` returns
 * `binds from unknown node "pdhook"` for exactly that graph — but every surface for it was
 * unreachable on a phone. The pill was behind `!phone`, the node's ⚠ carries its text in a
 * `title` (a hover tooltip, i.e. nothing on touch), and the dock banner that DOES spell it out is
 * reached by selecting the node, which is what the issues panel's rows do. One hidden control was
 * hiding the whole path.
 *
 * `PhoneWithIssues` is the story that would have caught it. Its neighbours stay hidden on a phone
 * deliberately: validity re-appears as a toast on save, and the environment is on the app shell's
 * own chip. A broken reference has neither, and it is the single most likely reason a saved
 * workflow fails at run time.
 */
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fireEvent, within } from "storybook/test";
import { CanvasTopBar } from "./TopBar";

// No router decorator here: preview.tsx wraps every story in ONE MemoryRouter, and nesting a
// second errors outright in react-router v7 ("You cannot render a <Router> inside another").
const meta: Meta<typeof CanvasTopBar> = {
  title: "Canvas/TopBar",
  component: CanvasTopBar,
  args: {
    name: "pagerduty-incident-triage",
    onNameChange: () => {},
    activeKey: "pagerduty-incident-triage",
    version: 19,
    generating: false,
    graphValid: true,
    issuesCount: 0,
    issuesSevere: false,
    hasVerdict: false,
    showIssues: false,
    onToggleIssues: () => {},
    busy: false,
    maySave: true,
    saveDeniedTitle: "",
    showAi: false,
    onToggleAi: () => {},
    showInput: false,
    onToggleInput: () => {},
    onImport: () => {},
    onExport: () => {},
    workflows: [],
    currentKeyParam: "pagerduty-incident-triage",
    onOpenWorkflow: () => {},
    onNewWorkflow: () => {},
    onSave: () => {},
    onCheck: () => {},
    checking: false,
    onRun: () => {},
    onRunDebug: () => {},
  },
};
export default meta;
type Story = StoryObj<typeof CanvasTopBar>;

const phone = { viewport: { defaultViewport: "mobile1" } };

/** Desktop, with the lint reporting a broken reference. */
export const WithIssues: Story = {
  args: { issuesCount: 3, issuesSevere: false },
};

/**
 * THE REGRESSION GUARD. At phone width the pill must still be here — compact (`⚠ 3`), but
 * present and tappable. If it disappears, a broken binding becomes undiagnosable on a phone.
 */
export const PhoneWithIssues: Story = {
  args: { issuesCount: 3, issuesSevere: false },
  parameters: phone,
  globals: { viewport: { value: "mobile1" } },
};

/** A severe issue (a missing connection / failed dry run) reads red rather than amber. */
export const PhoneWithSevereIssues: Story = {
  args: { issuesCount: 1, issuesSevere: true },
  parameters: phone,
  globals: { viewport: { value: "mobile1" } },
};

/** A clean dry run still has something to say — zero issues, but a verdict worth opening (#835). */
export const PhoneCheckedClean: Story = {
  args: { issuesCount: 0, hasVerdict: true, verdictOk: true },
  parameters: phone,
  globals: { viewport: { value: "mobile1" } },
};

/** Nothing to report: no pill at all, so the bar stays one clean row. */
export const PhoneQuiet: Story = {
  parameters: phone,
  globals: { viewport: { value: "mobile1" } },
};

/**
 * THE DENSEST PHONE STATE — and the one that made #964 undeniable. Both pills the phone bar keeps
 * (issues + `± changes`) are up, on a long name. `canReview` is deliberately part of it: it is not
 * in the shared args, so this combination had never actually been rendered anywhere.
 *
 * Measured at 390×844 before the fix (`getBoundingClientRect`, built Storybook), and note the
 * QUIET story was already broken — this one is just the worst case:
 *
 *                       name width      "Save & run" right edge (viewport 390)
 *   PhoneQuiet ........... 14px  ->  118      412  ->  364
 *   PhoneWithIssues ...... 14px  ->   68      462  ->  364
 *   PhoneCrowded ......... 14px  ->   32      499  ->  364
 *
 * 14px is the input's own padding: the name of the workflow being edited was not on screen in ANY
 * phone state. It is `flex: 1 1 auto; minWidth: 0` against a `flex: none` cluster, so it absorbed
 * every pixel of shortfall while the cluster overflowed — 22 to 109px past the right edge, under a
 * root that is `overflow-x: hidden`, so the primary CTA could not even be scrolled to (#511's
 * trap). Moving Save + "Check flow" into the `⋮` menu bought the row back ~166px.
 *
 * The crowded case is honestly still tight — 32px is about two characters — because the two pills
 * cost ~91px of a 390px row. It is legible-and-focusable rather than absent, and the CTA fits;
 * shrinking or moving the pills is a separate call (they were each put on the phone bar on
 * purpose, in #835 and #959).
 */
export const PhoneCrowded: Story = {
  args: {
    name: "pagerduty-incident-triage-escalation",
    issuesCount: 3,
    issuesSevere: false,
    canReview: true,
    showReview: false,
    onToggleReview: () => {},
  },
  parameters: phone,
  globals: { viewport: { value: "mobile1" } },
};

/**
 * …and where Save / Check flow went. At phone width they are menu items, not buttons — proof the
 * two actions the bar gives up are still reachable, and still carry their disabled reasons.
 */
export const PhoneMenuOpen: Story = {
  ...PhoneCrowded,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await fireEvent.click(canvas.getByRole("button", { name: "More actions" }));
    const menu = within(await canvas.findByRole("menu"));
    await expect(
      menu.getByRole("menuitem", { name: "Save" }),
    ).toBeInTheDocument();
    await expect(
      menu.getByRole("menuitem", { name: /Check flow/ }),
    ).toBeInTheDocument();
  },
};

const tablet = { viewport: { defaultViewport: "tablet" } };

/**
 * TABLET (iPad portrait, 834px) — the width #989 is about, and the state a real session is
 * actually in. The phone stories above under-report it: none of them sets `status`, `runCapUsd`
 * or `env`, and all three are on the tablet bar because everything there is gated on `!phone`.
 *
 * Measured on the built Storybook at 834×844, before -> after (`getBoundingClientRect`):
 *
 *                       name width       "Save & run" right edge (viewport 834)
 *   Tablet ............... 60  ->  142      1114 (+280 out)  ->  806
 *   TabletAiOpen ......... 60  ->  142      1074 (+240 out)  ->  806
 *   TabletInvalid ........ 60  ->  142      1215 (+381 out)  ->  806
 *   TabletQuiet .......... 80  ->  197       923  (+89 out)  ->  806
 *   WithIssues ........... 60  ->  197       974 (+140 out)  ->  806
 *
 * 60px is the name input's `minWidth` floor on the non-phone branch — the workflow you are
 * editing was ~7 characters wide — and the primary CTA sat 89 to 381px past the right edge of a
 * root that is `overflow-x: hidden`, so it could not be scrolled to either (#511's trap). Over
 * the whole `Canvas/TopBar` set the responsive audit goes 28 clipped elements / 19 unreachable
 * controls -> 0 / 0 at this width. Storybook builds with no `VITE_SENTRY_DSN`, so the 34px
 * "Send feedback" button is absent from these numbers; re-measured with it present, the same
 * stories fit at 768 and 834 (the workflow name takes the difference: 142 -> 98).
 *
 * What the tablet tier gives up (and why): the mono `key · v19` meta (~200px — a reference detail
 * with its own desktop home), the RUN CAP chip (Settings → Usage & budgets states the policy), and
 * the `✨ Build with AI` LABEL — the button stays, as an icon. What it keeps is every action plus
 * the env chip: the canvas is a sibling route of `/app`, so the shell's own env chip is NOT on
 * screen here, and "which environment does Save & run hit" is the one question worth the pixels.
 */
export const Tablet: Story = {
  args: {
    name: "pagerduty-incident-triage",
    issuesCount: 3,
    issuesSevere: false,
    canReview: true,
    showReview: false,
    onToggleReview: () => {},
    env: { name: "production", accent: "#f2622e", isProd: true },
    runCapUsd: 2.5,
    status: 'Saved as "PagerDuty incident triage" (pagerduty-incident-triage).',
  },
  parameters: tablet,
  globals: { viewport: { value: "tablet" } },
};

/** Same width, nothing to report — the floor case, and it overflowed by 89px too. */
export const TabletQuiet: Story = {
  parameters: tablet,
  globals: { viewport: { value: "tablet" } },
};

/**
 * …and where the tablet bar's `✨` goes. Icon-only from a tap, not hidden: AI authoring is the
 * differentiator, and #964's lesson was that a control with no other surface must not simply
 * disappear at a narrower width.
 */
export const TabletAiOpen: Story = {
  ...Tablet,
  args: { ...Tablet.args, showAi: true },
};

/**
 * The one piece of UNBOUNDED text left in the bar: the validity pill's label is
 * `graphError ?? "invalid"`, so a long lint message renders at whatever width it wants.
 *
 * It is deliberately NOT hidden at tablet, unlike its neighbours — it is the only visible answer
 * to "why is Save disabled", and the fallback the file's older comment claims (a toast on save)
 * does not exist: `save()` puts "Graph is not runnable." into `status`, which is the FIRST thing
 * this row squeezes to zero — and Save is disabled while the graph is invalid, so it cannot even
 * be pressed to get there. So the pill has to stay, and its worst case has to be measured rather
 * than assumed: 202px of pill put "Save & run" at 1215 in an 834px viewport. At compact the pill
 * now states the state and the message rides in its `title`.
 *
 * HONEST DATA: this story is still 48px over at 1440. That is the SAME unbounded label on the
 * DESKTOP bar, which #989's compact tier does not touch — measured identical before and after —
 * and it is left visible on purpose rather than tuned out of the story. See the follow-up issue
 * linked from PR "fix(canvas): a compact top-bar tier for tablet widths (#989)".
 */
export const TabletInvalid: Story = {
  ...Tablet,
  args: {
    ...Tablet.args,
    graphValid: false,
    graphError: "Start node has no outgoing edge",
    status: null,
  },
};
