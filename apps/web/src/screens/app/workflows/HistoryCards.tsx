/**
 * Version-history + recent-runs cards (workflow detail, redesign).
 *
 * Version history = the ACTIVE env's real snapshot list (GET /graphs/:key/versions):
 * vN · short content hash · created time. The backend stores no commit message or
 * author on a save, so none is invented — the only "who" we have is the promotion
 * lineage actor, shown on versions that arrived via promote. Env badges mark the
 * version whose content is currently live in each environment (matched by
 * contentHash, since version numbers are per-env counters).
 *
 * Recent runs = the latest real runs of this workflow from the runs list.
 */
import { useNavigate } from "react-router-dom";
import type { GraphVersion, RunSummary } from "../../../lib/api";
import { runStatusUi } from "../../../lib/run-status";
import { envAccent } from "../../../workspace/EnvironmentSwitcher";
import { ago, type EnvOverview, STATE_DOT } from "./model";

const card: React.CSSProperties = {
  border: "1px solid var(--line-mid)",
  background: "var(--panel)",
  borderRadius: 14,
  padding: "18px 20px",
};

const cardTitle: React.CSSProperties = {
  fontSize: "var(--text-body)",
  fontWeight: "var(--weight-bold)",
  color: "var(--ink)",
};

export function VersionHistoryCard({
  versions,
  overview,
  onCompare,
}: {
  /** ACTIVE-env history, newest first. */
  versions: GraphVersion[];
  overview: EnvOverview | null;
  onCompare: () => void;
}) {
  const activeEnvId = overview?.activeEnv?.id;
  // Which envs are live on each listed version's CONTENT (hash match).
  const badgesFor = (v: GraphVersion) =>
    (overview?.envs ?? []).filter(
      (s) => s.summary && s.versions[0]?.contentHash === v.contentHash,
    );
  // Promotions INTO the active env, keyed by the version they created here.
  const promotedInfo = (v: GraphVersion) =>
    overview?.promotions.find(
      (p) => p.toEnvId === activeEnvId && p.toVersion === v.version,
    );

  return (
    <div style={card}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 14,
        }}
      >
        <div style={cardTitle}>Version history</div>
        {versions.length >= 2 && (
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={onCompare}
          >
            Compare…
          </button>
        )}
      </div>
      {versions.length === 0 && (
        <div style={{ fontSize: "var(--text-sm)", color: "var(--ink-3)" }}>
          No saved versions in this environment.
        </div>
      )}
      <div style={{ display: "flex", flexDirection: "column" }}>
        {versions.map((v) => {
          const promo = promotedInfo(v);
          return (
            <div
              key={v.version}
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 12,
                padding: "11px 0",
                borderBottom: "1px solid var(--line)",
              }}
            >
              <span
                className="mono"
                style={{
                  fontSize: "var(--text-sm)",
                  fontWeight: "var(--weight-bold)",
                  color: "var(--ink-soft)",
                  width: 34,
                  textAlign: "center",
                  flex: "none",
                }}
              >
                v{v.version}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  className="mono"
                  style={{ fontSize: "var(--text-xs)", color: "var(--ink-2)" }}
                >
                  {v.contentHash.slice(0, 10)}
                </div>
                <div
                  style={{
                    fontSize: "var(--text-xs)",
                    color: "var(--ink-3)",
                    marginTop: 3,
                  }}
                >
                  {promo
                    ? `promoted by ${promo.actor} · ${ago(v.createdAt)}`
                    : ago(v.createdAt)}
                </div>
              </div>
              <span style={{ display: "flex", gap: 5, flex: "none" }}>
                {badgesFor(v).map((s) => {
                  const accent = envAccent(s.env);
                  return (
                    <span
                      key={s.env.id}
                      className="mono"
                      title={`This content is live in ${s.env.name}`}
                      style={{
                        fontSize: "var(--text-2xs)",
                        fontWeight: "var(--weight-bold)",
                        letterSpacing: "0.04em",
                        color: accent,
                        border: `1px solid ${accent}`,
                        borderRadius: 20,
                        padding: "2px 8px",
                      }}
                    >
                      {s.env.name}
                    </span>
                  );
                })}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function RecentRunsCard({ runs }: { runs: RunSummary[] }) {
  const navigate = useNavigate();
  return (
    <div style={card}>
      <div style={{ ...cardTitle, marginBottom: 14 }}>Recent runs</div>
      {runs.length === 0 && (
        <div style={{ fontSize: "var(--text-sm)", color: "var(--ink-3)" }}>
          No runs yet — hit “Run now” to try it.
        </div>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
        {runs.map((r) => {
          const ui = runStatusUi(r.status);
          const dot = STATE_DOT[ui.state];
          return (
            <div
              key={r.workflowId}
              role="link"
              tabIndex={0}
              onClick={() =>
                navigate(`/app/runs/${encodeURIComponent(r.workflowId)}`)
              }
              onKeyDown={(e) =>
                e.key === "Enter" &&
                navigate(`/app/runs/${encodeURIComponent(r.workflowId)}`)
              }
              className="run-row"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                cursor: "pointer",
                borderRadius: 7,
                padding: "4px 6px",
                margin: "-4px -6px",
              }}
            >
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  flex: "none",
                  background: dot,
                  boxShadow: `0 0 7px ${dot}`,
                }}
              />
              <span
                className="mono"
                style={{
                  fontSize: "var(--text-sm)",
                  color: "var(--ink-soft)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  maxWidth: 160,
                }}
              >
                {r.workflowId}
              </span>
              <span
                style={{
                  fontSize: "var(--text-xs)",
                  color: "var(--ink-faint)",
                }}
              >
                {ui.label}
                {r.graphVersion != null ? ` · v${r.graphVersion}` : ""}
              </span>
              <span
                className="mono"
                style={{
                  marginLeft: "auto",
                  fontSize: "var(--text-xs)",
                  color: "var(--ink-3)",
                  flex: "none",
                }}
              >
                {ago(r.startedAt)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
