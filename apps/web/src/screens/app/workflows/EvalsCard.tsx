/**
 * Evals card (workflow detail) — the UI half of #575.
 *
 * The backend has had golden datasets, batch runs, per-case verdicts and version-snapshotted
 * scores for a while; none of it was reachable outside `curl`, so a workflow's pass rate existed
 * and could not be seen. This renders the run history, the per-case drill-down, and the one
 * sentence AC2 asks for: "v9 passed 18/20 vs v8's 20/20".
 *
 * HONEST-DATA RULES observed here:
 *  - a run that measured no cases shows "—", never 0%;
 *  - cost shows "—" when the API reports null, never $0.00;
 *  - the comparison line is omitted entirely with fewer than two versions, rather than
 *    manufacturing a baseline;
 *  - nothing renders prompt or completion text, because the API deliberately never returns it.
 */
import { useCallback, useEffect, useState } from "react";
import { Card, Icon, Spinner } from "../../../components";
import { api, type EvalCaseResult, type EvalRun } from "../../../lib/api";
import { runState, versionComparison } from "./evals-model";

const DOT: Record<ReturnType<typeof runState>, string> = {
  done: "var(--state-done)",
  running: "var(--brand)",
  error: "var(--state-error)",
};

const pct = (passed: number, total: number): string =>
  total > 0 ? `${Math.round((passed / total) * 100)}%` : "—";

const money = (v: number | null): string =>
  v === null ? "—" : `$${v.toFixed(4)}`;

const ms = (v: number | null): string => (v === null ? "—" : `${v} ms`);

export function EvalsCard({ workflowKey }: { workflowKey: string }) {
  const [runs, setRuns] = useState<EvalRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [cases, setCases] = useState<Record<string, EvalCaseResult[]>>({});

  useEffect(() => {
    let live = true;
    api
      .listEvalRuns(workflowKey, 20)
      .then((r) => live && setRuns(r))
      .catch((e) => {
        // Say why. An empty card and a broken card must not look the same (#830).
        if (live)
          setError(
            e instanceof Error ? e.message : "Could not load eval runs.",
          );
      });
    return () => {
      live = false;
    };
  }, [workflowKey]);

  const toggle = useCallback(
    async (id: string) => {
      const next = open === id ? null : id;
      setOpen(next);
      if (!next || cases[id]) return;
      try {
        const full = await api.getEvalRun(id);
        setCases((c) => ({ ...c, [id]: full.cases }));
      } catch (e) {
        setError(
          e instanceof Error ? e.message : "Could not load the run's cases.",
        );
      }
    },
    [open, cases],
  );

  // Nothing configured is not a failure — say what the feature is instead of showing an empty box.
  if (runs !== null && runs.length === 0 && !error)
    return (
      <Card style={{ padding: 18 }}>
        <Title />
        <div style={{ fontSize: "var(--text-sm)", color: "var(--ink-3)" }}>
          No eval runs yet. A golden dataset runs this workflow against saved
          cases and records pass/fail, cost and latency per case — so a change
          can be compared against the version before it.
        </div>
      </Card>
    );

  const comparison = runs ? versionComparison(runs) : null;

  return (
    <Card style={{ padding: 18 }}>
      <Title />

      {error && (
        <div
          style={{
            fontSize: "var(--text-sm)",
            color: "var(--state-error)",
            marginBottom: 10,
          }}
        >
          {error}
        </div>
      )}

      {/* AC2's sentence. Absent — not faked — until there are two versions to compare. */}
      {comparison && (
        <div
          style={{
            fontSize: "var(--text-sm)",
            color: "var(--ink-2)",
            marginBottom: 12,
          }}
        >
          {comparison}
        </div>
      )}

      {runs === null && !error && (
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Spinner />
          <span style={{ fontSize: "var(--text-sm)", color: "var(--ink-3)" }}>
            Loading eval runs…
          </span>
        </div>
      )}

      {(runs ?? []).map((r) => {
        const state = runState(r);
        const isOpen = open === r.id;
        return (
          <div
            key={r.id}
            style={{ borderTop: "1px solid var(--line)", padding: "10px 0" }}
          >
            <button
              type="button"
              aria-expanded={isOpen}
              onClick={() => void toggle(r.id)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                width: "100%",
                background: "none",
                border: "none",
                padding: 0,
                cursor: "pointer",
                color: "var(--ink)",
                textAlign: "left",
              }}
            >
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  flex: "none",
                  background: DOT[state],
                  boxShadow: `0 0 7px ${DOT[state]}`,
                }}
              />
              <span
                className="mono"
                style={{ fontSize: "var(--text-xs)", color: "var(--ink-3)" }}
              >
                v{r.graphVersion}
              </span>
              <span
                style={{ fontSize: "var(--text-sm)", flex: 1, minWidth: 0 }}
              >
                {r.datasetName}
              </span>
              <span className="mono" style={{ fontSize: "var(--text-xs)" }}>
                {r.passed}/{r.totalCases} · {pct(r.passed, r.totalCases)}
              </span>
              <span
                className="mono"
                style={{ fontSize: "var(--text-xs)", color: "var(--ink-3)" }}
              >
                {money(r.costUsd)}
              </span>
              <Icon
                name={isOpen ? "chevron-down" : "chevron-right"}
                size={14}
                style={{ color: "var(--ink-3)", flex: "none" }}
              />
            </button>

            {isOpen && (
              <div style={{ marginTop: 8, paddingLeft: 18 }}>
                {!cases[r.id] ? (
                  <span
                    style={{
                      fontSize: "var(--text-xs)",
                      color: "var(--ink-3)",
                    }}
                  >
                    Loading cases…
                  </span>
                ) : (
                  cases[r.id].map((c) => (
                    <div
                      key={c.caseName}
                      style={{
                        display: "flex",
                        gap: 10,
                        alignItems: "baseline",
                        padding: "3px 0",
                        fontSize: "var(--text-xs)",
                      }}
                    >
                      <span
                        style={{
                          color:
                            c.verdict === "pass"
                              ? "var(--state-done)"
                              : "var(--state-error)",
                          width: 44,
                          flex: "none",
                        }}
                      >
                        {c.verdict}
                      </span>
                      <span
                        style={{ flex: 1, minWidth: 0, color: "var(--ink-2)" }}
                      >
                        {c.caseName}
                      </span>
                      <span className="mono" style={{ color: "var(--ink-3)" }}>
                        {ms(c.latencyMs)}
                      </span>
                      <span className="mono" style={{ color: "var(--ink-3)" }}>
                        {money(c.costUsd)}
                      </span>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        );
      })}
    </Card>
  );
}

function Title() {
  return (
    <div
      style={{
        fontSize: "var(--text-body)",
        fontWeight: "var(--weight-semibold)",
        color: "var(--ink)",
        marginBottom: 10,
      }}
    >
      Evals
    </div>
  );
}
