import { Button, Icon } from "../../../components";
import type { CheckedRequirement, ConnectionRequirement } from "./model";

/**
 * The post-import connection setup checklist (#574): every connection the installed
 * template's graph actually needs, cross-referenced against the workspace's real
 * connections, so a template that needs one the workspace lacks says so here instead of
 * failing mid-run.
 *
 * `checked === null` means the workspace's connections could not be loaded — the rows
 * then render WITHOUT a satisfied/missing verdict. A red "missing" state derived from a
 * failed fetch would be a fabricated fact.
 */
export function ConnectionChecklist({
  requirements,
  checked,
  onConnect,
}: {
  requirements: ConnectionRequirement[];
  /** Verdicts, or null when connections couldn't be loaded (render no verdict). */
  checked: CheckedRequirement[] | null;
  /** Open Integrations on the tab that hosts this connection's form. */
  onConnect: (tab: "apps" | "providers") => void;
}) {
  if (requirements.length === 0) return null;

  const rows: (ConnectionRequirement & Partial<CheckedRequirement>)[] =
    checked ?? requirements;
  const unmet = checked
    ? checked.filter((c) => c.status !== "satisfied").length
    : null;

  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 9,
          marginBottom: 11,
        }}
      >
        <div className="section-label">Connections it needs</div>
        {unmet !== null && (
          <span
            className="mono"
            style={{
              fontSize: 10.5,
              color: unmet > 0 ? "var(--state-paused)" : "var(--state-done)",
              fontWeight: "var(--weight-bold)",
            }}
          >
            {unmet > 0
              ? `${unmet} of ${rows.length} still to set up`
              : "all set up"}
          </span>
        )}
      </div>

      <div
        style={{
          border: "1px solid var(--line-mid)",
          background: "var(--card)",
          borderRadius: "var(--radius-lg)",
          padding: 14,
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
      >
        {checked === null && (
          <div style={{ fontSize: "var(--text-xs)", color: "var(--ink-3)" }}>
            Couldn&apos;t load this workspace&apos;s connections, so these
            aren&apos;t checked against it — open Integrations to confirm each
            one exists.
          </div>
        )}

        {rows.map((r) => {
          const status = r.status;
          const tone =
            status === "satisfied"
              ? "var(--state-done)"
              : status === "unhealthy"
                ? "var(--state-paused)"
                : status === "missing"
                  ? "var(--state-error)"
                  : "var(--ink-3)";
          const icon =
            status === "satisfied"
              ? "check-circle"
              : status === undefined
                ? "plug"
                : "alert";
          return (
            <div
              key={r.id}
              style={{ display: "flex", alignItems: "flex-start", gap: 11 }}
            >
              <span
                style={{
                  width: 28,
                  height: 28,
                  flex: "none",
                  borderRadius: 8,
                  border: `1px solid ${tone}`,
                  color: tone,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Icon name={icon} size={15} strokeWidth={2} />
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    flexWrap: "wrap",
                  }}
                >
                  <span
                    style={{
                      fontSize: "var(--text-sm)",
                      fontWeight: "var(--weight-bold)",
                      color: "var(--ink)",
                    }}
                  >
                    {r.label}
                  </span>
                  {status && (
                    <span
                      className="mono"
                      style={{ fontSize: 10, color: tone }}
                    >
                      {status === "satisfied"
                        ? `connected · ${r.connectionLabel}`
                        : status === "unhealthy"
                          ? // Report what the connection ACTUALLY is (mirrors the
                            // Integrations screen's wording), not a guessed cause.
                            `${r.connectionLabel} ${
                              r.connectionStatus === "error"
                                ? "is erroring"
                                : "needs reconnecting"
                            }`
                          : "not connected"}
                    </span>
                  )}
                </div>
                <div
                  style={{
                    fontSize: "var(--text-xs)",
                    color: "var(--ink-2)",
                    marginTop: 3,
                    lineHeight: 1.5,
                  }}
                >
                  {r.reason}
                </div>
              </div>
              {status !== "satisfied" && (
                <Button
                  variant="secondary"
                  size="sm"
                  icon="plug"
                  onClick={() => onConnect(r.tab)}
                  style={{ flex: "none" }}
                >
                  {status === "unhealthy" ? "Fix" : "Connect"}
                </Button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * The gallery/preview one-liner: just the names of the connections a template needs, with
 * the unmet ones called out. No verdict at all when `checked` is null.
 */
export function ConnectionNeedsLine({
  requirements,
  checked,
}: {
  requirements: ConnectionRequirement[];
  checked: CheckedRequirement[] | null;
}) {
  if (requirements.length === 0) return null;
  const rows: (ConnectionRequirement & Partial<CheckedRequirement>)[] =
    checked ?? requirements;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 7,
        flexWrap: "wrap",
        fontSize: "var(--text-xs)",
        color: "var(--ink-3)",
      }}
    >
      <Icon name="plug" size={13} />
      <span>Needs</span>
      {rows.map((r) => (
        <span
          key={r.id}
          style={{
            padding: "2px 8px",
            borderRadius: "var(--radius-pill)",
            border: "1px solid var(--line-mid)",
            color:
              r.status === "satisfied"
                ? "var(--state-done)"
                : r.status === undefined
                  ? "var(--ink-2)"
                  : "var(--state-paused)",
          }}
        >
          {r.label}
        </span>
      ))}
    </div>
  );
}
