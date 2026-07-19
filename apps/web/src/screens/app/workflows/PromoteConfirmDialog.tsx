/**
 * Promote confirmation (redesign "Naary Workflows.dc.html") — env-accent warning
 * tile + copy derived from the REAL versions on both sides. Confirming runs the
 * actual copy-on-promote (POST /graphs/:key/promote). Version numbers are
 * per-env counters, so the copy names the source content ("sandbox v9") and the
 * version it replaces in the target ("prod v6") rather than pretending they
 * share a counter.
 */
import { Icon, Spinner } from "../../../components";
import type { Environment } from "../../../lib/api";
import { envAccent } from "../../../workspace/EnvironmentSwitcher";
import { isProdLike } from "./model";

export function PromoteConfirmDialog({
  open,
  onClose,
  onConfirm,
  busy,
  source,
  target,
  targetVersion,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  busy: boolean;
  /** The promote source: the ACTIVE env + the version being copied. */
  source: { env: Environment; version: number } | null;
  target: Environment | null;
  /** The target env's current version of this workflow (null = first deploy). */
  targetVersion: number | null;
}) {
  if (!open || !source || !target) return null;
  const accent = envAccent(target);
  const prod = isProdLike(target);
  return (
    <div className="overlay" onClick={onClose} style={{ padding: 36 }}>
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 440,
          maxWidth: "100%",
          margin: "auto",
          background: "var(--panel)",
          border: "1px solid var(--line-mid)",
          borderRadius: 16,
          boxShadow: "0 40px 100px -40px rgba(0,0,0,.8)",
          overflow: "hidden",
          animation: "naaryPopIn .22s ease",
        }}
      >
        <div style={{ padding: "22px 24px" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 11,
              marginBottom: 12,
            }}
          >
            <span
              style={{
                width: 38,
                height: 38,
                flex: "none",
                borderRadius: 10,
                border: `1px solid ${accent}`,
                color: accent,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Icon name="alert" size={19} />
            </span>
            <div>
              <div
                style={{
                  fontSize: 16,
                  fontWeight: "var(--weight-bold)",
                  color: "var(--ink)",
                }}
              >
                Promote to {target.name}?
              </div>
              <div
                style={{
                  fontSize: "var(--text-xs)",
                  color: "var(--ink-faint)",
                }}
              >
                {targetVersion === null
                  ? `first deploy to ${target.name}`
                  : `replaces ${target.name} v${targetVersion}`}
                {prod ? " · affects live traffic" : ""}
              </div>
            </div>
          </div>
          <div
            style={{
              fontSize: "var(--text-sm)",
              color: "var(--ink-2)",
              lineHeight: 1.6,
              marginBottom: 4,
            }}
          >
            {targetVersion === null ? (
              <>
                <strong style={{ color: "var(--ink)" }}>{target.name}</strong>{" "}
                has no version of this workflow yet.
              </>
            ) : (
              <>
                <strong style={{ color: "var(--ink)" }}>{target.name}</strong>{" "}
                is running{" "}
                <strong style={{ color: "var(--ink)" }}>
                  v{targetVersion}
                </strong>
                .
              </>
            )}{" "}
            Promoting copies{" "}
            <strong style={{ color: "var(--ink)" }}>
              {source.env.name} v{source.version}
            </strong>{" "}
            into {target.name} as a new version, effective immediately.
            In-flight runs finish on the graph they started with; new runs use
            the promoted version. Earlier versions stay in the history for
            rollback.
          </div>
        </div>
        <div
          style={{
            padding: "14px 24px",
            borderTop: "1px solid var(--line)",
            display: "flex",
            gap: 10,
          }}
        >
          <button
            type="button"
            className="btn btn-secondary"
            style={{ flex: 1 }}
            disabled={busy}
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            style={{ flex: 1 }}
            disabled={busy}
            onClick={onConfirm}
          >
            {busy ? <Spinner size={14} /> : `Promote to ${target.name}`}
          </button>
        </div>
      </div>
    </div>
  );
}
