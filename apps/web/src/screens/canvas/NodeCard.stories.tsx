import type { Meta, StoryObj } from "@storybook/react-vite";
import type { CSSProperties } from "react";
import { NodeCard, type NodeRunState } from "./NodeCard";

/**
 * The redesigned canvas node card (Canvas Authoring Loop): card colour = run
 * state, icon colour = node type. Pure/presentational — the canvas wraps it
 * with react-flow handles.
 */
const meta: Meta<typeof NodeCard> = {
  title: "Canvas/Node card",
  component: NodeCard,
  parameters: { layout: "centered" },
};
export default meta;
type Story = StoryObj<typeof NodeCard>;

const stage: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 22,
  padding: 32,
  background:
    "radial-gradient(120% 90% at 20% 0%, var(--grad-a), var(--bg) 60%)",
  borderRadius: 14,
};

/** Every run state the card can render (the app drives the subset it can honestly
 *  know: idle / running / done / failed / stale / no-input). */
export const AllStates: Story = {
  render: () => {
    const states: {
      state: NodeRunState;
      note: string;
      runMs?: number;
      pinned?: boolean;
    }[] = [
      { state: "idle", note: "not run yet" },
      { state: "queued", note: "about to start" },
      { state: "running", note: "ember glow-pulse + bottom progress strip" },
      { state: "waiting", note: "amber pulse + ping ring" },
      { state: "done", note: "measured duration", runMs: 840 },
      { state: "error", note: "test failed" },
      { state: "skipped", note: "untaken branch — dashed + dimmed" },
      { state: "stale", note: "inputs changed upstream", runMs: 1260 },
      { state: "no-input", note: "no inbound edge" },
    ];
    return (
      <div style={stage}>
        {states.map(({ state, note, runMs, pinned }) => (
          <div
            key={state}
            style={{ display: "flex", alignItems: "center", gap: 18 }}
          >
            <div style={{ width: 250 }}>
              <NodeCard
                kind="agent"
                title="Summarize deal"
                subtitle="LLM · claude-opus-4-8"
                state={state}
                runMs={runMs}
                pinned={pinned}
                onRun={() => {}}
                onDelete={() => {}}
              />
            </div>
            <span
              className="mono"
              style={{ fontSize: 11, color: "var(--ink-3)" }}
            >
              {state} — {note}
            </span>
          </div>
        ))}
      </div>
    );
  },
};

/** Type accents: icon tile colour = node type (trigger / agent / mcp / router /
 *  approval / http / end), per the design's node-type palette. */
export const TypeAccents: Story = {
  render: () => (
    <div style={stage}>
      <NodeCard
        kind="webhookTrigger"
        title="Webhook"
        subtitle="trigger · webhook"
        pinned
        onRun={() => {}}
      />
      <NodeCard
        kind="httpRequest"
        title="Enrich company"
        subtitle="GET api.clearbit.com"
        onRun={() => {}}
      />
      <NodeCard
        kind="agent"
        title="Summarize deal"
        subtitle="LLM · claude-opus-4-8"
        onRun={() => {}}
      />
      <NodeCard
        kind="mcpTool"
        title="MCP Tool"
        subtitle="github · create_issue"
        costChip="$0.0004/call"
        onRun={() => {}}
      />
      <NodeCard
        kind="switch"
        title="Route by value"
        subtitle="switch · condition"
        onRun={() => {}}
      />
      <NodeCard
        kind="humanApproval"
        title="Human approval"
        subtitle="durable · can wait days"
        state="waiting"
        onRun={() => {}}
      />
      <NodeCard
        kind="codeAgent"
        title="Code Agent"
        subtitle="claude · read-only"
        costChip="cap $2"
        onRun={() => {}}
      />
      <NodeCard kind="end" title="End" />
    </div>
  ),
};

/** Selected ring (with the ✕ delete micro-button visible), lint warning badge,
 *  and the pinned-data badge together. */
export const BadgesAndSelection: Story = {
  render: () => (
    <div style={stage}>
      <NodeCard
        kind="agent"
        title="Summarize deal"
        subtitle="LLM · claude-opus-4-8"
        selected
        state="done"
        runMs={2600}
        pinned
        onRun={() => {}}
        onDelete={() => {}}
      />
      <NodeCard
        kind="httpRequest"
        title="Enrich company"
        subtitle="GET api.example.com"
        warning={'references connection "clearbit" which doesn\'t exist'}
        onRun={() => {}}
      />
    </div>
  ),
};
