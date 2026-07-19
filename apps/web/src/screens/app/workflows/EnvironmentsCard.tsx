/**
 * Environments card (workflow detail, redesign "Naary Workflows.dc.html") — one
 * tile per environment showing the version live there (real per-env data), a
 * glow dot in the env color, a drift chip computed by content-hash against the
 * ACTIVE env's history, and the "View diff" / "Promote" actions wired to the
 * real diff + copy-on-promote machinery (promote copies FROM the active env).
 */
import { Icon } from "../../../components";
import type { Environment } from "../../../lib/api";
import { envAccent } from "../../../workspace/EnvironmentSwitcher";
import {
  ago,
  drift,
  type Drift,
  type EnvOverview,
  type EnvSlot,
} from "./model";

function driftChip(d: Drift, activeName: string): { text: string; fg: string } {
  switch (d.kind) {
    case "same":
      return { text: "up to date", fg: "var(--state-done)" };
    case "behind":
      return {
        text: `${d.behind} version${d.behind === 1 ? "" : "s"} behind`,
        fg: "var(--state-paused)",
      };
    case "diverged":
      return { text: `differs from ${activeName}`, fg: "var(--state-paused)" };
    case "missing":
      return { text: "not deployed", fg: "var(--ink-3)" };
  }
}

function EnvTile({
  slot,
  isActive,
  activeSlot,
}: {
  slot: EnvSlot;
  isActive: boolean;
  activeSlot: EnvSlot | null;
}) {
  const accent = envAccent(slot.env);
  // Drift is measured against the ACTIVE env (the promote source). The active
  // tile itself is the reference, so it carries no chip.
  const chip =
    !isActive && activeSlot
      ? driftChip(
          drift(activeSlot.versions, slot.versions[0]?.contentHash),
          activeSlot.env.name,
        )
      : null;
  return (
    <div
      style={{
        flex: 1,
        minWidth: 150,
        border: `1px solid ${isActive ? accent : "var(--line-mid)"}`,
        background: isActive
          ? `color-mix(in srgb, ${accent} 8%, var(--card))`
          : "var(--card)",
        borderRadius: 12,
        padding: "14px 15px",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: accent,
            boxShadow: `0 0 8px ${accent}`,
            flex: "none",
          }}
        />
        <span
          style={{
            fontSize: "var(--text-sm)",
            fontWeight: "var(--weight-bold)",
            color: accent,
          }}
        >
          {slot.env.name}
        </span>
        {isActive && (
          <span
            className="mono"
            style={{
              marginLeft: "auto",
              fontSize: "var(--text-2xs)",
              color: "var(--ink-3)",
              letterSpacing: "0.06em",
            }}
          >
            ACTIVE
          </span>
        )}
      </div>
      <div
        className="mono"
        style={{
          fontSize: 20,
          fontWeight: "var(--weight-bold)",
          color: "var(--ink)",
          marginTop: 9,
        }}
      >
        {slot.summary ? `v${slot.summary.version}` : "—"}
      </div>
      <div
        style={{
          fontSize: "var(--text-xs)",
          color: "var(--ink-faint)",
          marginTop: 2,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {slot.summary
          ? slot.promotedBy
            ? `promoted by ${slot.promotedBy.actor} · ${ago(slot.promotedBy.at)}`
            : `updated ${ago(slot.summary.updatedAt)}`
          : "no version here yet"}
      </div>
      {chip && (
        <span
          className="mono"
          style={{
            marginTop: 10,
            display: "inline-block",
            fontSize: "var(--text-2xs)",
            fontWeight: "var(--weight-semibold)",
            color: chip.fg,
            background: `color-mix(in srgb, ${chip.fg} 12%, transparent)`,
            border: `1px solid color-mix(in srgb, ${chip.fg} 35%, transparent)`,
            borderRadius: 20,
            padding: "3px 9px",
          }}
        >
          {chip.text}
        </span>
      )}
    </div>
  );
}

export function EnvironmentsCard({
  overview,
  target,
  onTargetChange,
  mayPromote,
  onViewDiff,
  onPromote,
}: {
  overview: EnvOverview;
  /** The promote/diff target env (a non-active env), chosen by the parent. */
  target: Environment | null;
  onTargetChange: (envId: string) => void;
  mayPromote: boolean;
  onViewDiff: () => void;
  onPromote: () => void;
}) {
  const { envs, activeEnv } = overview;
  const activeSlot = envs.find((s) => s.env.id === activeEnv?.id) ?? null;
  const candidates = envs.filter((s) => s.env.id !== activeEnv?.id);

  return (
    <div
      style={{
        border: "1px solid var(--line-mid)",
        background: "var(--panel)",
        borderRadius: 14,
        padding: "18px 20px",
        marginBottom: 16,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", marginBottom: 15 }}>
        <div
          style={{
            fontSize: "var(--text-body)",
            fontWeight: "var(--weight-bold)",
            color: "var(--ink)",
          }}
        >
          Environments
        </div>
        <span
          className="mono"
          style={{
            marginLeft: "auto",
            fontSize: "var(--text-xs)",
            color: "var(--ink-3)",
          }}
        >
          promote right →
        </span>
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "stretch",
          gap: 10,
          flexWrap: "wrap",
        }}
      >
        {envs.map((slot) => (
          <EnvTile
            key={slot.env.id}
            slot={slot}
            isActive={slot.env.id === activeEnv?.id}
            activeSlot={activeSlot}
          />
        ))}
      </div>

      {activeEnv && candidates.length > 0 && (
        <>
          <div
            style={{
              display: "flex",
              gap: 10,
              marginTop: 15,
              alignItems: "center",
              flexWrap: "wrap",
            }}
          >
            {candidates.length > 1 && (
              <label
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  fontSize: "var(--text-xs)",
                  color: "var(--ink-3)",
                }}
              >
                to
                <select
                  aria-label="Promotion target environment"
                  value={target?.id ?? ""}
                  onChange={(e) => onTargetChange(e.target.value)}
                  style={{
                    fontSize: "var(--text-sm)",
                    padding: "5px 8px",
                    borderRadius: "var(--radius-sm)",
                    border: "1px solid var(--line-2)",
                    background: "var(--card)",
                    color: "var(--ink)",
                  }}
                >
                  {candidates.map((s) => (
                    <option key={s.env.id} value={s.env.id}>
                      {s.env.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {target && (
              <>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={onViewDiff}
                >
                  <Icon name="workflow" size={14} />
                  View diff: {activeEnv.name} → {target.name}
                </button>
                {mayPromote && (
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={onPromote}
                  >
                    <Icon name="arrow-right" size={14} />
                    Promote {activeEnv.name} → {target.name}
                  </button>
                )}
              </>
            )}
          </div>
          <div
            style={{
              fontSize: "var(--text-xs)",
              color: "var(--ink-3)",
              marginTop: 10,
              lineHeight: "var(--leading-snug)",
            }}
          >
            Promote copies this workflow’s current graph from{" "}
            <strong>{activeEnv.name}</strong> into the target as a new version.
            Credentials & connections are not copied — the target env uses its
            own.
          </div>
        </>
      )}
    </div>
  );
}
