// Unresolved-inputs diagnostic section for the RunDetail screen.
import type { UnresolvedRef } from "@naary/dsl";
import { Card, Icon } from "../../../components";

/* ---- Unresolved inputs (which source produced no output) ------------------------
 * The worker writes `ctx.__unresolved` (keyed by node id) when a node's input reference — a
 * `{{ source.path }}` token OR a `{from,path}` binding — resolved to nothing because its SOURCE
 * produced no output. This is the "the run looked complete but a node silently got empty input"
 * diagnostic: it names exactly which node, which field, and which source was missing. */
function unresolvedRefs(ctx: Record<string, unknown>): UnresolvedRef[] {
  const raw = ctx.__unresolved;
  if (raw === null || typeof raw !== "object") return [];
  return Object.values(raw as Record<string, UnresolvedRef[]>)
    .flat()
    .filter((r): r is UnresolvedRef => !!r && typeof r === "object");
}

export function UnresolvedInputsSection({
  ctx,
}: {
  ctx: Record<string, unknown>;
}) {
  const refs = unresolvedRefs(ctx);
  if (refs.length === 0) return null;
  return (
    <Card
      style={{
        padding: "16px 20px",
        marginBottom: 16,
        borderColor: "color-mix(in srgb, var(--state-paused) 45%, transparent)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 6,
        }}
      >
        <Icon name="alert" size={16} style={{ color: "var(--state-paused)" }} />
        <span
          style={{
            fontSize: "var(--text-md)",
            fontWeight: "var(--weight-semibold)",
          }}
        >
          Unresolved inputs
        </span>
      </div>
      <div
        style={{
          fontSize: "var(--text-2xs)",
          color: "var(--ink-3)",
          marginBottom: 10,
        }}
      >
        These inputs read from a source that produced no output, so the node ran
        with them empty — a likely cause of a node that looks fine but did
        nothing.
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {refs.map((r, i) => (
          <div
            key={`${r.nodeId}.${r.field}.${i}`}
            style={{ fontSize: "var(--text-sm)", color: "var(--ink-1)" }}
          >
            <span
              className="mono"
              style={{ fontWeight: "var(--weight-semibold)" }}
            >
              {r.nodeId}
            </span>{" "}
            · field <span className="mono">{r.field}</span> reads{" "}
            <span className="mono">{r.ref}</span> —{" "}
            <span style={{ color: "var(--ink-2)" }}>
              {r.sourceExists
                ? `"${r.from}" ran but produced no output on this branch`
                : `no node "${r.from}" — check the source id`}
            </span>
          </div>
        ))}
      </div>
    </Card>
  );
}
