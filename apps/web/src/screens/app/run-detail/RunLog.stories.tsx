/**
 * The Execution log.
 *
 * It used to be Temporal's view of the run — `Run started`, `Activity: runNodeActivity`,
 * `Activity completed` — which says that something ran but not what it did. `WithStepRows` is the
 * state to look at: one row per executed step, interleaved by finish time, each opening onto what
 * that step was given and what it produced.
 *
 * The collapsed line carries an allowlist of non-content metadata only (model, status, tokens,
 * cost). Bodies live behind the caret, never in the line — see NodeLogRows for why the split
 * matters and `node-log-rows.spec.ts` for the tests that hold it in place.
 */
import type { Meta, StoryObj } from "@storybook/react-vite";
import { type LogEntry, LogPanel } from "./RunLog";

const T = (mins: number, secs: number) =>
  new Date(Date.UTC(2026, 6, 31, 14, mins, secs)).toISOString();

/** The curated Temporal events, on their own — what every run's log showed before. */
const TEMPORAL_ROWS: LogEntry[] = [
  { id: 1, at: T(22, 1), kind: "started", label: "Run started" },
  {
    id: 2,
    at: T(22, 1),
    kind: "activity",
    label: "Activity: runNodeActivity",
  },
  { id: 8, at: T(22, 4), kind: "activity", label: "Activity completed" },
  { id: 9, at: T(22, 6), kind: "completed", label: "Run completed" },
];

const STEP_ROWS: LogEntry[] = [
  {
    id: "node-schedule",
    at: T(22, 3),
    kind: "node",
    label: "Schedule (schedule)  ·  180ms",
    nodeId: "schedule",
    output: { firedAt: "2026-07-31T14:22:03.000Z" },
  },
  {
    id: "node-pagerduty",
    at: T(22, 4),
    kind: "node",
    label: "HTTP Request (pagerduty)  ·  1.2s  ·  status=200",
    nodeId: "pagerduty",
    // The `$secrets` token is LITERAL here because the runtime leaves it literal — the value is
    // resolved in-memory inside the activity and never enters the run's data.
    input: {
      method: "POST",
      url: "https://api.pagerduty.com/incidents",
      headers: { Authorization: "{{ $secrets.PD_TOKEN }}" },
      body: { title: "Disk full on web-03" },
    },
    output: {
      httpStatus: 200,
      body: { id: "PD-4471", status: "triggered" },
    },
  },
  {
    id: "node-triage",
    at: T(22, 5),
    kind: "node",
    label: "Agent (triage)  ·  2.4s  ·  model=opus  ·  tokens=1,204",
    nodeId: "triage",
    input: { prompt: "Summarise incident PD-4471 for the on-call channel." },
    output: {
      model: "claude-opus-4-8",
      totalTokens: 1204,
      costUsd: 0.0231,
      text: "Disk usage on web-03 crossed 95%. Log rotation appears stalled.",
    },
  },
];

const byTime = (rows: LogEntry[]) =>
  [...rows].sort((a, b) => (a.at ?? "").localeCompare(b.at ?? ""));

const meta: Meta<typeof LogPanel> = {
  title: "RunDetail/LogPanel",
  component: LogPanel,
  decorators: [
    (Story) => (
      <div style={{ width: 720 }}>
        <Story />
      </div>
    ),
  ],
};
export default meta;
type Story = StoryObj<typeof LogPanel>;

/** Every run: step rows interleaved with the Temporal events. Open one for its input/output. */
export const WithStepRows: Story = {
  args: { events: byTime([...TEMPORAL_ROWS, ...STEP_ROWS]) },
};

/**
 * A step that ran more than once — a loop iteration or a retry attempt. Only the LAST run's values
 * survive in the run's data, so the panel says so instead of presenting them as this line's.
 */
export const RepeatedStep: Story = {
  args: {
    events: [
      {
        id: "node-fetch",
        at: T(22, 4),
        kind: "node",
        label: "HTTP Request (fetch)  ·  820ms ×3  ·  status=200",
        nodeId: "fetch",
        ranTimes: 3,
        input: { url: "https://api/flaky" },
        output: { httpStatus: 200, body: { ok: true } },
      },
    ],
  },
};

/** Temporal rows alone: no step produced anything to open, so no row grows a caret. */
export const TemporalEventsOnly: Story = { args: { events: TEMPORAL_ROWS } };

/** Still fetching the history. */
export const Loading: Story = { args: { events: null } };

/** A run so young it has no events yet. */
export const Empty: Story = { args: { events: [] } };
