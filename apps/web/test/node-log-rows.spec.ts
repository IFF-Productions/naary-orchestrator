// Per-step rows for the Execution log: what goes in the LINE, and what goes behind the caret.
//
// The split is the whole design. The collapsed line is skimmed, so it carries an allowlist of
// non-content metadata and nothing else — those tests are unchanged from when the rows were
// debug-only, and they go on guarding the same property. The input/output payload is STRUCTURED
// and separate, so it can never smear into the line it sits under.
import { describe, expect, it } from "vitest";
import {
  buildNodeLogRows,
  type LogRowNode,
  resolvedInput,
  safeFields,
} from "../src/screens/app/run-detail/NodeLogRows";
import type { TimelineStep } from "../src/screens/app/run-detail/StepTimeline";

const step = (p: Partial<TimelineStep> & { id: string }): TimelineStep => ({
  label: p.id,
  icon: "workflow",
  accent: "var(--ink-3)",
  state: "done",
  duration: null,
  durationMs: null,
  cost: null,
  ...p,
});

describe("safeFields — allowlist (the collapsed LINE never carries content)", () => {
  it("surfaces only allowlisted metadata from an agent output", () => {
    const out = safeFields({
      model: "claude-opus-4-8",
      totalTokens: 1234,
      costUsd: 0.0231,
      // content that must NEVER appear:
      output: { review: "the customer's SSN is 123-45-6789" },
      text: "secret completion text",
    });
    expect(out).toEqual([
      "model=claude-opus-4-8",
      "tokens=1,234",
      "cost=$0.0231",
    ]);
    expect(out.join(" ")).not.toContain("SSN");
    expect(out.join(" ")).not.toContain("completion");
  });

  it("surfaces http status/pages but not the response body/headers", () => {
    const out = safeFields({
      httpStatus: 200,
      pages: 3,
      headers: { authorization: "Bearer sk-secret" },
      body: { token: "ghp_leak" },
    });
    expect(out).toEqual(["status=200", "pages=3"]);
    expect(out.join(" ")).not.toContain("Bearer");
    expect(out.join(" ")).not.toContain("ghp_leak");
  });

  it("drops nested-object allowlisted values and omits zero cost", () => {
    // costUsd 0 → omitted; a model that's somehow an object → skipped (never stringified).
    expect(safeFields({ costUsd: 0, model: { nested: "x" } })).toEqual([]);
  });

  it("returns [] for a non-object / array output", () => {
    expect(safeFields("plain string output")).toEqual([]);
    expect(safeFields([1, 2, 3])).toEqual([]);
    expect(safeFields(null)).toEqual([]);
  });
});

// ── The input view ────────────────────────────────────────────────────────────────────────────
//
// Nothing records a step's real inputs, so this reconstructs them: the step's own config, resolved
// against the run's ctx with the interpreter's own resolver.
describe("resolvedInput", () => {
  const node = (config?: Record<string, unknown>): LogRowNode => ({
    id: "call",
    type: "httpRequest",
    config,
  });

  it("fills the step's settings in with the run's data", () => {
    const out = resolvedInput(
      node({ url: "https://api/x/{{ lookup.id }}", method: "POST" }),
      { lookup: { id: "NAARY-42" } },
    );
    expect(out).toEqual({ url: "https://api/x/NAARY-42", method: "POST" });
  });

  it("leaves a $secrets reference LITERAL — the value is never in ctx to begin with", () => {
    // This is the privacy property, and it is not enforced here: `resolveTemplates` leaves secret
    // refs alone because the RUNTIME leaves them alone (they're resolved in-memory inside the
    // activity, Tier-1 §4). Reusing the runtime's resolver is what makes it true by construction.
    const out = resolvedInput(
      node({ headers: { Authorization: "{{ $secrets.PD_TOKEN }}" } }),
      {},
    );
    expect(out).toEqual({
      headers: { Authorization: "{{ $secrets.PD_TOKEN }}" },
    });
  });

  it("still leaves it literal when a ctx somehow CARRIES a $secrets value", () => {
    // The mutation guard. If the token were resolved by ordinary path lookup, this ctx would leak
    // the value — `isSecretRef` short-circuits before the lookup, so it cannot.
    const out = resolvedInput(node({ token: "{{ $secrets.PD_TOKEN }}" }), {
      $secrets: { PD_TOKEN: "super-secret-value" },
    } as Record<string, unknown>);
    expect(JSON.stringify(out)).not.toContain("super-secret-value");
    expect(out).toEqual({ token: "{{ $secrets.PD_TOKEN }}" });
  });

  it("resolves $vars, which are not secret and DO live in ctx", () => {
    const out = resolvedInput(node({ region: "{{ $vars.REGION }}" }), {
      $vars: { REGION: "eu" },
    });
    expect(out).toEqual({ region: "eu" });
  });

  it("has no input for a node with no config, rather than an empty object", () => {
    // `undefined` is what makes the panel omit the INPUT block entirely — `{}` would render a
    // heading over nothing.
    expect(resolvedInput(node(undefined), {})).toBeUndefined();
    expect(resolvedInput(node({}), {})).toBeUndefined();
    expect(resolvedInput(undefined, {})).toBeUndefined();
  });
});

describe("buildNodeLogRows — one row per executed step", () => {
  it("emits a row per EXECUTED step, stamped with finish time + safe fields", () => {
    const steps: TimelineStep[] = [
      step({ id: "agent", label: "Agent", state: "done", duration: "340ms" }),
      step({ id: "skipped", state: "skipped" }), // not executed → no row
      step({ id: "pending", state: "pending" }), // not executed → no row
    ];
    const ctx = { agent: { model: "opus", costUsd: 0.02, text: "SECRET" } };
    const nodeTimes = { agent: { s: 1000, f: 1340 } };

    const rows = buildNodeLogRows({ steps, ctx, nodeTimes });

    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("node");
    expect(rows[0].at).toBe(new Date(1340).toISOString()); // finish time → sortable into timeline
    expect(rows[0].label).toBe(
      "Agent (agent)  ·  340ms  ·  model=opus  ·  cost=$0.0200",
    );
    expect(rows[0].label).not.toContain("SECRET"); // the LINE never carries content
  });

  it("is emitted for an ORDINARY run — no `__debug` needed", () => {
    // These rows used to exist only when the run was started with debug: true, which meant the
    // log said nothing per-step on exactly the runs people open when something went wrong.
    const rows = buildNodeLogRows({
      steps: [step({ id: "n" })],
      ctx: {}, // no __debug
      nodeTimes: null,
    });
    expect(rows).toHaveLength(1);
  });

  it("carries the step's output as PAYLOAD, not as row text", () => {
    const ctx = { agent: { text: "the full completion body" } };
    const rows = buildNodeLogRows({
      steps: [step({ id: "agent", label: "Agent" })],
      ctx,
      nodeTimes: null,
    });
    expect(rows[0].output).toEqual({ text: "the full completion body" });
    expect(rows[0].nodeId).toBe("agent");
    // …and the same content is absent from the line that renders collapsed.
    expect(rows[0].label).not.toContain("full completion");
  });

  it("carries the step's resolved input as payload", () => {
    const nodes = new Map<string, LogRowNode>([
      [
        "call",
        {
          id: "call",
          type: "httpRequest",
          config: { url: "https://api/{{ trigger.id }}" },
        },
      ],
    ]);
    const rows = buildNodeLogRows({
      steps: [step({ id: "call" })],
      ctx: { trigger: { id: "42" } },
      nodeTimes: null,
      nodes,
    });
    expect(rows[0].input).toEqual({ url: "https://api/42" });
  });

  it("marks an ordinary step's output as its OWN, so the panel can address it", () => {
    // `hasCtxOutput` is what lets the expanded row pass runId/nodeId to NodeOutputBody — the
    // address a textToSpeech step's audio fetch needs. Without it the log would render a quietly
    // less capable version of the same output the step card shows.
    const rows = buildNodeLogRows({
      steps: [step({ id: "speak" })],
      ctx: { speak: { audioRef: "runs/x/speak.mp3" } },
      nodeTimes: null,
    });
    expect(rows[0].hasCtxOutput).toBe(true);
  });

  it("marks the entry step's FALLBACK output as not its own", () => {
    // The run input standing in for an entry node that wrote nothing is not addressable as
    // `<runId>/<nodeId>` — it isn't that node's output at all.
    const rows = buildNodeLogRows({
      steps: [step({ id: "start" })],
      ctx: { __input: { ticketId: "NAARY-1" } },
      nodeTimes: null,
      startNodeId: "start",
    });
    expect(rows[0].hasCtxOutput).toBe(false);
  });

  it("uses stepOutputView for the ENTRY step, so it matches the step card", () => {
    // An older run's entry node published nothing to ctx; the step card falls back to the run's
    // trigger input. The log row has to agree — two panels disagreeing about one step's output is
    // worse than either being empty.
    const rows = buildNodeLogRows({
      steps: [step({ id: "start" })],
      ctx: { __input: { ticketId: "NAARY-1" } },
      nodeTimes: null,
      startNodeId: "start",
    });
    expect(rows[0].output).toEqual({ ticketId: "NAARY-1" });
  });

  it("flags a step that ran more than once, so its values aren't read as this line's", () => {
    // A loop iteration or a retry attempt overwrites ctx, so only the LAST run's values survive.
    const rows = buildNodeLogRows({
      steps: [step({ id: "fetch" })],
      ctx: { fetch: { status: 200 } },
      nodeTimes: { fetch: { s: 10, f: 90, n: 3 } },
    });
    expect(rows[0].ranTimes).toBe(3);
  });

  it("does not flag a step that ran once", () => {
    const rows = buildNodeLogRows({
      steps: [step({ id: "fetch" })],
      ctx: {},
      nodeTimes: { fetch: { s: 10, f: 90, n: 1 } },
    });
    expect(rows[0].ranTimes).toBeUndefined();
  });

  it("gives an untimed executed step a null `at` (caller sorts those last)", () => {
    const rows = buildNodeLogRows({
      steps: [step({ id: "n", state: "done" })],
      ctx: {},
      nodeTimes: null,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].at).toBeNull();
  });
});
