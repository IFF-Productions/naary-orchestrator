/**
 * Shared data model for the redesigned Workflows screens (list + detail).
 *
 * Everything here is derived from REAL control-plane data:
 * - env presence / "Live in" — per-environment `GET /graphs` (the same endpoint the
 *   list uses, with an `x-environment-id` override per env);
 * - trigger — the graph's entry node (`graph.startNodeId`);
 * - drift — content-hash comparison across each env's version history (version
 *   NUMBERS are per-env counters, so "N versions behind" is computed by locating
 *   the other env's latest contentHash inside the reference env's history);
 * - who/when — GraphSummary.updatedAt + the promotion lineage (actor is only
 *   recorded for promoted versions, so it is only shown there).
 */
import { useCallback, useEffect, useState } from "react";
import type { GraphDef, NodeType } from "@naary/dsl";
import type { IconName, RunState } from "../../../components";
import {
  api,
  type Environment,
  getActiveEnvironment,
  type GraphSummary,
  type GraphVersion,
  type Promotion,
} from "../../../lib/api";
import { http } from "../../../lib/api/http";
import { nodeDisplayLabel } from "../../../lib/graph-model";
import { envAccent } from "../../../workspace/EnvironmentSwitcher";

/* ---------------- time ---------------- */

/** Compact relative time from an ISO timestamp (no date lib). */
export function ago(iso: string): string {
  const then = new Date(iso).getTime();
  const s = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/* ---------------- environments ---------------- */

/** Env "height" by slug/name convention (mirrors envAccent): prod > uat/staging > rest. */
export function envRank(env: Pick<Environment, "slug" | "name">): number {
  const key = `${env.slug} ${env.name}`.toLowerCase();
  if (/prod/.test(key)) return 3;
  if (/uat|stag|test|qa/.test(key)) return 2;
  return 1;
}

export const isProdLike = (env: Pick<Environment, "slug" | "name">): boolean =>
  envRank(env) === 3;

/** sandbox → UAT → prod display order (rank ascending, name as tiebreak). */
export function sortEnvs(envs: Environment[]): Environment[] {
  return [...envs].sort(
    (a, b) => envRank(a) - envRank(b) || a.name.localeCompare(b.name),
  );
}

/** The env the app is currently scoped to (header X-Environment-Id), resolved
 *  against the workspace's env list; falls back to the default env. */
export function resolveActiveEnv(envs: Environment[]): Environment | null {
  const active = getActiveEnvironment();
  return (
    (active
      ? envs.find((e) => e.id === active || e.slug === active)
      : undefined) ??
    envs.find((e) => e.isDefault) ??
    envs[0] ??
    null
  );
}

/** `GET /graphs` scoped to a SPECIFIC environment (header override — `http` merges
 *  init.headers last, so this wins over the module-level active env). */
export function listGraphsInEnv(envId: string): Promise<GraphSummary[]> {
  return http<GraphSummary[]>("/graphs", {
    headers: { "x-environment-id": envId },
  });
}

/** `GET /graphs/:key/versions` scoped to a SPECIFIC environment. */
export function listVersionsInEnv(
  workflowKey: string,
  envId: string,
): Promise<GraphVersion[]> {
  return http<GraphVersion[]>(
    `/graphs/${encodeURIComponent(workflowKey)}/versions`,
    { headers: { "x-environment-id": envId } },
  );
}

/* ---------------- trigger (entry node) ---------------- */

export interface TriggerInfo {
  /** Human label — "Webhook", "Form", "Schedule", … ("Manual" for a Start node). */
  label: string;
  icon: IconName;
  /** Node-type accent for the icon tile. */
  accent: string;
}

const TRIGGER_ICON: Partial<Record<NodeType, IconName>> = {
  start: "play",
  webhookTrigger: "bolt",
  errorTrigger: "alert",
  scheduleTrigger: "clock",
  pollTrigger: "refresh",
  formTrigger: "template",
  chatTrigger: "agent",
};

/** The workflow's trigger, read from the graph's REAL entry node. A malformed
 *  or partial API response (no graph/nodes) degrades to "Manual" instead of
 *  white-screening the list. */
export function triggerInfo(graph: GraphDef | undefined): TriggerInfo {
  const nodes = graph?.nodes ?? [];
  const entry = nodes.find((n) => n.id === graph?.startNodeId) ?? nodes[0];
  if (!entry) return { label: "Manual", icon: "play", accent: "var(--ink-3)" };
  const type = entry.type as NodeType;
  return {
    label:
      type === "start"
        ? "Manual"
        : nodeDisplayLabel(type, entry.config as Record<string, unknown>),
    icon: TRIGGER_ICON[type] ?? "bolt",
    accent: "var(--node-trigger)",
  };
}

/** Icon for any node type (diff rows) — coarse but honest buckets. */
export function nodeIcon(type: NodeType): IconName {
  if (TRIGGER_ICON[type]) return TRIGGER_ICON[type] as IconName;
  switch (type) {
    case "agent":
    case "codeAgent":
    case "vectorUpsert":
    case "vectorQuery":
      return "agent";
    case "textToSpeech":
      return "activity";
    case "mcpTool":
    case "integration":
      return "mcp";
    case "if":
    case "switch":
    case "merge":
    case "splitOut":
    case "loopEnd":
    case "forEach":
    case "executeSubWorkflow":
      return "router";
    case "humanApproval":
      return "approval";
    case "httpRequest":
    case "graphQL":
      return "http";
    case "wait":
      return "clock";
    case "end":
      return "end";
    default:
      return "workflow";
  }
}

/* ---------------- run-state dots ---------------- */

export const STATE_DOT: Record<RunState, string> = {
  running: "var(--state-running)",
  paused: "var(--state-paused)",
  done: "var(--state-done)",
  error: "var(--state-error)",
  info: "var(--state-info)",
  idle: "var(--ink-3)",
};

/* ---------------- "Live in" status ---------------- */

export interface EnvPresence {
  env: Environment;
  summary: GraphSummary;
}

export interface LiveIn {
  /** Glow-dot color: the accent of the highest env the workflow exists in. */
  dot: string;
  label: string;
  /** Status text color (Live = ok, Paused = warn, Draft = faint, env name = env accent). */
  color: string;
}

/** Where a workflow effectively "is": the highest-ranked env it exists in,
 *  refined by activation there (prod + inactive = Paused). */
export function liveIn(presences: EnvPresence[]): LiveIn | null {
  if (presences.length === 0) return null;
  const top = [...presences].sort((a, b) => envRank(b.env) - envRank(a.env))[0];
  const accent = envAccent(top.env);
  if (isProdLike(top.env)) {
    return top.summary.active
      ? { dot: accent, label: "Live", color: "var(--state-done)" }
      : { dot: accent, label: "Paused", color: "var(--state-paused)" };
  }
  if (envRank(top.env) === 2) {
    return { dot: accent, label: top.env.name, color: accent };
  }
  return { dot: accent, label: "Draft", color: "var(--ink-faint)" };
}

/* ---------------- drift (content-hash comparison) ---------------- */

export type Drift =
  | { kind: "same" }
  | { kind: "behind"; behind: number }
  | { kind: "diverged" }
  | { kind: "missing" };

/**
 * How far an env's latest content is from the reference env's, by locating its
 * latest contentHash in the reference history (newest first). Version numbers
 * are per-env counters, so hashes are the only honest cross-env comparison.
 */
export function drift(
  refVersions: GraphVersion[],
  otherLatestHash: string | null | undefined,
): Drift {
  if (!otherLatestHash) return { kind: "missing" };
  const idx = refVersions.findIndex((v) => v.contentHash === otherLatestHash);
  if (idx === 0) return { kind: "same" };
  if (idx > 0) return { kind: "behind", behind: idx };
  return { kind: "diverged" };
}

/* ---------------- detail: per-env overview ---------------- */

export interface EnvSlot {
  env: Environment;
  /** The workflow's latest summary in that env (null = not deployed there). */
  summary: GraphSummary | null;
  /** That env's version history for this workflow (newest first). */
  versions: GraphVersion[];
  /** Set when the env's current version arrived via a recorded promotion. */
  promotedBy?: { actor: string; at: string };
}

export interface EnvOverview {
  envs: EnvSlot[];
  activeEnv: Environment | null;
  promotions: Promotion[];
}

/** Loads the full cross-environment picture for one workflow. */
export function useEnvOverview(workflowKey: string): {
  overview: EnvOverview | null;
  reload: () => void;
} {
  const [overview, setOverview] = useState<EnvOverview | null>(null);
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let live = true;
    (async () => {
      const me = await api.getMe();
      const envs = sortEnvs(await api.listEnvironments(me.tenantId));
      const promotions = await api
        .listPromotions(workflowKey)
        .catch(() => [] as Promotion[]);
      const slots = await Promise.all(
        envs.map(async (env): Promise<EnvSlot> => {
          const [summaries, versions] = await Promise.all([
            listGraphsInEnv(env.id).catch(() => [] as GraphSummary[]),
            listVersionsInEnv(workflowKey, env.id).catch(
              () => [] as GraphVersion[],
            ),
          ]);
          const summary =
            summaries.find((g) => g.workflowKey === workflowKey) ?? null;
          const promo = summary
            ? promotions.find(
                (p) => p.toEnvId === env.id && p.toVersion === summary.version,
              )
            : undefined;
          return {
            env,
            summary,
            versions,
            promotedBy: promo
              ? { actor: promo.actor, at: promo.createdAt }
              : undefined,
          };
        }),
      );
      if (!live) return;
      setOverview({
        envs: slots,
        activeEnv: resolveActiveEnv(envs),
        promotions,
      });
    })().catch(() => live && setOverview(null));
    return () => {
      live = false;
    };
  }, [workflowKey, nonce]);

  return { overview, reload };
}
