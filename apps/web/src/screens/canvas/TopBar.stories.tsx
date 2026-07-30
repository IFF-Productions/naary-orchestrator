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
