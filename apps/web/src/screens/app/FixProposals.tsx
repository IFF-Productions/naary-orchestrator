/**
 * PROPOSED FIXES — the human step in self-healing.
 *
 * A failed run of an opted-in workflow diagnoses itself and proposes a graph edit, then parks on a
 * durable wait for someone to decide. Until this screen existed the endpoints were reachable only
 * by hand: the loop ran end to end except its last step, which is the one that matters, because
 * nothing is applied without it.
 *
 * THE DIFF IS THE POINT. Approving writes a new version of a production workflow, so the decision
 * has to be made against what actually changed, not a summary of it. `GraphDiffBody` is the same
 * renderer the version-history modal and the canvas review panel use — extracted for exactly this,
 * so a proposal's diff looks like every other diff in the product rather than a third dialect.
 *
 * The diff is computed HERE, in the browser, from the proposed graph and the current one:
 * `diffGraphs` is pure, and asking the server to pre-compute it would be a second code path that
 * could disagree with the canvas about what "changed" means.
 */
import { useCallback, useEffect, useState } from "react";
import { diffGraphs, type GraphDef, type GraphDiff } from "@naary/dsl";
import { Button, Icon, Spinner } from "../../components";
import { api, type FixProposal } from "../../lib/api";
import { GraphDiffBody } from "./workflows/GraphDiffBody";

/** One proposal, expanded to its diff. Loaded lazily — the list shows counts, not graphs. */
interface Expanded {
  diff: GraphDiff | null;
  /** Why the diff couldn't be shown. Approving without seeing it is not offered. */
  error: string | null;
}

export function FixProposals() {
  const [rows, setRows] = useState<FixProposal[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, Expanded>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setRows(await api.listFixProposals());
      setError(null);
    } catch {
      setError("Couldn't load proposed fixes.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** Fetch the proposed graph + the workflow's current one, and diff them in the browser. */
  async function expand(p: FixProposal): Promise<void> {
    if (openId === p.id) {
      setOpenId(null);
      return;
    }
    setOpenId(p.id);
    if (expanded[p.id]) return;
    try {
      const [detail, current] = await Promise.all([
        api.getFixProposal(p.id),
        api.getGraph(p.workflowKey),
      ]);
      setExpanded((e) => ({
        ...e,
        [p.id]: {
          diff: diffGraphs(
            current.graph,
            // The proposal endpoint types the graph loosely (it round-trips through JSONB), so
            // this is the one place it has to be narrowed back.
            detail.proposedGraph as unknown as GraphDef,
          ),
          error: null,
        },
      }));
    } catch {
      setExpanded((e) => ({
        ...e,
        [p.id]: {
          diff: null,
          error:
            "Couldn't load the change this proposes, so there is nothing to review yet. Try again, or open the workflow to see its current version.",
        },
      }));
    }
  }

  async function decide(p: FixProposal, approve: boolean): Promise<void> {
    setBusy(p.id);
    try {
      if (approve) await api.approveFixProposal(p.id);
      else await api.rejectFixProposal(p.id);
      await load();
      setOpenId(null);
    } catch (e) {
      // The server's own wording, which is the useful part: a STALE proposal names both versions
      // and says why applying it would discard work. A generic "couldn't approve" would hide the
      // one thing the user needs in order to act.
      setError(
        e instanceof Error ? e.message : "Couldn't record that decision.",
      );
    } finally {
      setBusy(null);
    }
  }

  return (
    <div style={{ padding: "22px 26px", maxWidth: 960 }}>
      <h1
        style={{
          fontSize: 19,
          fontWeight: "var(--weight-bold)",
          color: "var(--ink)",
          margin: 0,
        }}
      >
        Proposed fixes
      </h1>
      <p
        style={{
          fontSize: "var(--text-sm)",
          color: "var(--ink-2)",
          lineHeight: 1.6,
          margin: "6px 0 18px",
        }}
      >
        When a workflow with self-healing enabled fails, its failure is
        diagnosed and a change is proposed here. Nothing is applied until you
        approve it — review the diff first.
      </p>

      {error && (
        <div
          style={{
            fontSize: "var(--text-sm)",
            color: "var(--state-error)",
            marginBottom: 14,
            lineHeight: 1.6,
          }}
        >
          {error}
        </div>
      )}

      {rows === null && !error && <Spinner size={16} />}

      {rows?.length === 0 && (
        <div style={{ fontSize: "var(--text-sm)", color: "var(--ink-3)" }}>
          Nothing waiting. Proposals appear here after a failed run of a
          workflow with “Suggest a fix when this fails” switched on.
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {rows?.map((p) => {
          const open = openId === p.id;
          const ex = expanded[p.id];
          return (
            <div
              key={p.id}
              style={{
                border: "1px solid var(--line)",
                borderRadius: 12,
                background: "var(--card)",
                overflow: "hidden",
              }}
            >
              <button
                type="button"
                onClick={() => void expand(p)}
                aria-expanded={open}
                style={{
                  all: "unset",
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  padding: "13px 15px",
                  width: "100%",
                  boxSizing: "border-box",
                }}
              >
                <Icon
                  name={open ? "chevron-down" : "chevron-right"}
                  size={14}
                />
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span
                    style={{
                      display: "block",
                      fontSize: "var(--text-sm)",
                      fontWeight: "var(--weight-semibold)",
                      color: "var(--ink)",
                    }}
                  >
                    {p.workflowKey}
                  </span>
                  <span
                    className="mono"
                    style={{
                      display: "block",
                      fontSize: "var(--text-xs)",
                      color: "var(--ink-faint)",
                      marginTop: 2,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {p.failureSummary}
                  </span>
                </span>
                <span
                  className="mono"
                  style={{
                    fontSize: "var(--text-xs)",
                    color: "var(--ink-faint)",
                    flex: "none",
                  }}
                >
                  {p.diffSummary.total} change
                  {p.diffSummary.total === 1 ? "" : "s"} · v{p.baseVersion}
                </span>
              </button>

              {open && (
                <div
                  style={{
                    borderTop: "1px solid var(--line)",
                    padding: "13px 15px",
                  }}
                >
                  {!ex && <Spinner size={14} />}
                  {ex?.error && (
                    <div
                      style={{
                        fontSize: "var(--text-sm)",
                        color: "var(--state-error)",
                        lineHeight: 1.6,
                      }}
                    >
                      {ex.error}
                    </div>
                  )}
                  {ex?.diff && <GraphDiffBody diff={ex.diff} />}

                  <div
                    style={{
                      display: "flex",
                      gap: 8,
                      marginTop: 14,
                      alignItems: "center",
                    }}
                  >
                    <Button
                      variant="primary"
                      loading={busy === p.id}
                      // Approving writes a new version, so it stays unavailable until the diff is
                      // on screen. "Approve a change you couldn't see" is not a thing to offer.
                      disabled={!ex?.diff || busy !== null}
                      onClick={() => void decide(p, true)}
                    >
                      Approve &amp; apply
                    </Button>
                    <Button
                      variant="secondary"
                      disabled={busy !== null}
                      onClick={() => void decide(p, false)}
                    >
                      Reject
                    </Button>
                    <span
                      style={{
                        fontSize: "var(--text-xs)",
                        color: "var(--ink-faint)",
                        marginLeft: 4,
                      }}
                    >
                      Applies to v{p.baseVersion} — refused if the workflow has
                      changed since.
                    </span>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
