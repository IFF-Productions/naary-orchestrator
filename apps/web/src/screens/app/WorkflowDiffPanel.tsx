/**
 * "Compare versions" panel for the workflow detail screen. Picks two saved versions and shows the
 * STRUCTURAL diff between them — which nodes were added / removed / changed, which edges were
 * rewired or reordered, and whether the entry node moved. The diff itself is computed server-side
 * (GET /graphs/:key/diff → the pure diffGraphs in @naary/dsl); this just renders it.
 *
 * Use before promoting a workflow to a higher environment: review what actually changed.
 */
import { useEffect, useState } from "react";
import type { GraphDiff, NodeType } from "@naary/dsl";
import { Card, Icon, Spinner } from "../../components";
import { type GraphVersion, api } from "../../lib/api";
import { nodeDisplayLabel } from "../../lib/graph-model";

type Diff = GraphDiff & { fromVersion: number; toVersion: number };
type DiffNode = GraphDiff["nodesAdded"][number];
type DiffEdge = GraphDiff["edgesAdded"][number];

/** A node's friendly type label + its stable id (the diff matches nodes by id). */
function nodeLabel(n: DiffNode): string {
  return `${nodeDisplayLabel(n.type as NodeType, n.config)} · ${n.id}`;
}

function edgeLabel(e: DiffEdge): string {
  const cond = e.condition ? ` [${e.condition.path} ${e.condition.op}]` : "";
  return `${e.from} → ${e.to}${cond}`;
}

/** True when the diff has no structural change at all. */
function isEmpty(d: GraphDiff): boolean {
  return (
    d.nodesAdded.length === 0 &&
    d.nodesRemoved.length === 0 &&
    d.nodesChanged.length === 0 &&
    d.edgesAdded.length === 0 &&
    d.edgesRemoved.length === 0 &&
    !d.edgesReordered &&
    !d.startNodeChanged
  );
}

function Row({
  icon,
  color,
  children,
}: {
  icon: "plus" | "x" | "edit";
  color: string;
  children: React.ReactNode;
}) {
  return (
    <li
      style={{
        display: "flex",
        alignItems: "baseline",
        gap: 8,
        padding: "3px 0",
        fontSize: "var(--text-sm)",
      }}
    >
      <Icon name={icon} style={{ color, flex: "none" }} size={13} />
      <span style={{ fontFamily: "var(--font-mono, monospace)" }}>
        {children}
      </span>
    </li>
  );
}

function Section({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  if (count === 0) return null;
  return (
    <div style={{ marginTop: 10 }}>
      <div
        style={{
          fontSize: "var(--text-2xs, 10px)",
          textTransform: "uppercase",
          letterSpacing: "0.04em",
          color: "var(--ink-3)",
          marginBottom: 2,
        }}
      >
        {title} ({count})
      </div>
      <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>{children}</ul>
    </div>
  );
}

export function WorkflowDiffPanel({ workflowKey }: { workflowKey: string }) {
  const [versions, setVersions] = useState<GraphVersion[] | null>(null);
  const [from, setFrom] = useState<number | "">("");
  const [to, setTo] = useState<number | "">("");
  const [diff, setDiff] = useState<Diff | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();

  // Load the version list once; default from = the previous version, to = the latest.
  useEffect(() => {
    let alive = true;
    api
      .listGraphVersions(workflowKey)
      .then((vs) => {
        if (!alive) return;
        setVersions(vs);
        if (vs.length >= 2) {
          setTo(vs[0].version); // newest first
          setFrom(vs[1].version);
        } else if (vs.length === 1) {
          setTo(vs[0].version);
          setFrom(vs[0].version);
        }
      })
      .catch(() => alive && setVersions([]));
    return () => {
      alive = false;
    };
  }, [workflowKey]);

  async function compare() {
    if (from === "" || to === "") return;
    setLoading(true);
    setError(undefined);
    setDiff(null);
    try {
      setDiff(await api.diffGraphVersions(workflowKey, from, to));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not compute the diff.");
    } finally {
      setLoading(false);
    }
  }

  if (versions === null) return null; // still loading the list — stay quiet
  if (versions.length < 2) {
    return (
      <Card pad={false} style={{ padding: 14, marginTop: 16 }}>
        <div style={{ fontSize: "var(--text-sm)", color: "var(--ink-3)" }}>
          Only one saved version — nothing to compare yet.
        </div>
      </Card>
    );
  }

  const pick = (
    value: number | "",
    onChange: (v: number) => void,
    label: string,
  ) => (
    <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <span style={{ fontSize: "var(--text-xs)", color: "var(--ink-3)" }}>
        {label}
      </span>
      <select
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{
          fontSize: "var(--text-sm)",
          padding: "4px 8px",
          borderRadius: 6,
          border: "1px solid var(--line-2)",
          background: "var(--card)",
          color: "var(--ink)",
        }}
      >
        {versions.map((v) => (
          <option key={v.version} value={v.version}>
            v{v.version}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <Card pad={false} style={{ padding: 14, marginTop: 16 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <span style={{ fontSize: "var(--text-body)", fontWeight: 600 }}>
          Compare versions
        </span>
        {pick(from, setFrom, "from")}
        <span style={{ color: "var(--ink-3)" }}>→</span>
        {pick(to, setTo, "to")}
        <button
          type="button"
          onClick={compare}
          disabled={loading || from === "" || to === ""}
          style={{
            all: "unset",
            cursor: loading ? "default" : "pointer",
            padding: "5px 12px",
            borderRadius: 6,
            background: "var(--brand)",
            color: "var(--brand-ink, #fff)",
            fontSize: "var(--text-sm)",
            opacity: loading ? 0.6 : 1,
          }}
        >
          {loading ? <Spinner size={13} /> : "Compare"}
        </button>
      </div>

      {error && (
        <div
          style={{
            marginTop: 10,
            fontSize: "var(--text-sm)",
            color: "var(--state-error)",
          }}
        >
          {error}
        </div>
      )}

      {diff && (
        <div style={{ marginTop: 12 }}>
          <div
            style={{
              fontSize: "var(--text-sm)",
              color: "var(--ink-2)",
              marginBottom: 4,
            }}
          >
            v{diff.fromVersion} → v{diff.toVersion}
            {diff.startNodeChanged && (
              <span style={{ color: "var(--state-warn, #e2a844)" }}>
                {" "}
                · entry node changed
              </span>
            )}
            {diff.edgesReordered && (
              <span style={{ color: "var(--state-warn, #e2a844)" }}>
                {" "}
                · edges reordered (affects branch precedence)
              </span>
            )}
          </div>

          {isEmpty(diff) ? (
            <div style={{ fontSize: "var(--text-sm)", color: "var(--ink-3)" }}>
              No structural changes between these versions.
            </div>
          ) : (
            <>
              <Section title="Nodes added" count={diff.nodesAdded.length}>
                {diff.nodesAdded.map((n) => (
                  <Row
                    key={n.id}
                    icon="plus"
                    color="var(--state-done, #46b06a)"
                  >
                    {nodeLabel(n)}
                  </Row>
                ))}
              </Section>
              <Section title="Nodes removed" count={diff.nodesRemoved.length}>
                {diff.nodesRemoved.map((n) => (
                  <Row key={n.id} icon="x" color="var(--state-error)">
                    {nodeLabel(n)}
                  </Row>
                ))}
              </Section>
              <Section title="Nodes changed" count={diff.nodesChanged.length}>
                {diff.nodesChanged.map((c) => (
                  <Row
                    key={c.id}
                    icon="edit"
                    color="var(--state-warn, #e2a844)"
                  >
                    {nodeLabel(c.after)}
                    <span style={{ color: "var(--ink-3)" }}>
                      {" "}
                      ({c.fields.join(", ")})
                    </span>
                  </Row>
                ))}
              </Section>
              <Section title="Edges added" count={diff.edgesAdded.length}>
                {diff.edgesAdded.map((e, i) => (
                  <Row
                    key={`${edgeLabel(e)}:${i}`}
                    icon="plus"
                    color="var(--state-done, #46b06a)"
                  >
                    {edgeLabel(e)}
                  </Row>
                ))}
              </Section>
              <Section title="Edges removed" count={diff.edgesRemoved.length}>
                {diff.edgesRemoved.map((e, i) => (
                  <Row
                    key={`${edgeLabel(e)}:${i}`}
                    icon="x"
                    color="var(--state-error)"
                  >
                    {edgeLabel(e)}
                  </Row>
                ))}
              </Section>
            </>
          )}
        </div>
      )}
    </Card>
  );
}
