// Feed-shaped ingestion: rssRead + pollTrigger (change detection).
import { createHash } from "node:crypto";
import { ApplicationFailure } from "@temporalio/activity";
import { XMLParser } from "fast-xml-parser";
import { getByPath } from "@naary/dsl";
import type { PollTriggerNodeConfig, ResolvedRss } from "@naary/dsl";
import {
  BlockedEgressError,
  assertEgressAllowed,
  safeFetch,
} from "@naary/connections";
import { getDefaultEnvironmentId, getPrisma } from "@naary/db";
import { activityDuration, activityRuns, secondsSince } from "../../metrics";
import { type AgentMeta, toSanitizedRetryable } from "./shared";

export interface RssItem {
  title: string;
  link: string;
  summary: string;
  published: string;
  id: string;
}
export interface RssResult {
  status: "ok";
  items: RssItem[];
  count: number;
  costUsd: number;
}

const DEFAULT_RSS_TIMEOUT_MS = 15_000;
const MAX_RSS_TIMEOUT_MS = 30_000;
const MAX_RSS_ITEMS = 100; // feeds are small; bound the inline payload anyway.

// Injectable I/O seam for the rssRead activity (swapped in unit tests).
export const __rssDeps = {
  // SSRF-hardened: guarded connector re-checks every redirect hop + pins the
  // validated IP (closes S-1 redirect-bypass + S-2 DNS-rebind).
  fetch: (url: string, init?: RequestInit) =>
    safeFetch(url, init as never) as unknown as Promise<Response>,
  assertEgressAllowed,
};

/** Flatten an XML text node (fast-xml-parser may give a string or {#text}). */
function xmlText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "object" && "#text" in (v as Record<string, unknown>)) {
    return String((v as Record<string, unknown>)["#text"]);
  }
  return typeof v === "object" ? "" : String(v);
}

/** Normalize RSS 2.0 `channel.item` or Atom `feed.entry` into items. */
function normalizeFeed(parsed: Record<string, unknown>): RssItem[] {
  const rss = parsed.rss as { channel?: { item?: unknown } } | undefined;
  const feed = parsed.feed as { entry?: unknown } | undefined;
  const raw = rss?.channel?.item ?? feed?.entry ?? [];
  const arr = Array.isArray(raw) ? raw : [raw];
  return arr
    .filter(Boolean)
    .slice(0, MAX_RSS_ITEMS)
    .map((it) => {
      const item = it as Record<string, unknown>;
      // Atom <link href="…"> vs RSS <link>text</link>.
      const rawLink = item.link as unknown;
      const link =
        typeof rawLink === "string"
          ? rawLink
          : xmlText((rawLink as Record<string, unknown>)?.["@_href"]) ||
            xmlText(rawLink);
      return {
        title: xmlText(item.title),
        link,
        summary: xmlText(item.description ?? item.summary ?? item.content),
        published: xmlText(item.pubDate ?? item.published ?? item.updated),
        id: xmlText(item.guid ?? item.id) || link,
      };
    });
}

/**
 * rssRead node — fetch an RSS/Atom feed (egress-guarded, https + public host) and
 * parse it into normalized items. No secrets; the URL is non-secret.
 */
export async function callRssRead(
  cfg: ResolvedRss,
  _input: unknown,
  meta: AgentMeta,
): Promise<RssResult> {
  const startedAt = process.hrtime.bigint();
  void meta;
  try {
    await __rssDeps.assertEgressAllowed(cfg.url); // https + public (SSRF guard)
    const controller = new AbortController();
    const timeoutMs = Math.min(
      cfg.timeoutMs ?? DEFAULT_RSS_TIMEOUT_MS,
      MAX_RSS_TIMEOUT_MS,
    );
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let xml: string;
    try {
      const res = await __rssDeps.fetch(cfg.url, { signal: controller.signal });
      xml = await res.text();
    } finally {
      clearTimeout(timer);
    }
    const parsed = new XMLParser({ ignoreAttributes: false }).parse(xml) as
      Record<string, unknown> | undefined;
    const items = parsed ? normalizeFeed(parsed) : [];
    activityRuns.inc({ activity: "callRssRead", outcome: "ok" });
    activityDuration.observe(
      { activity: "callRssRead" },
      secondsSince(startedAt),
    );
    return { status: "ok", items, count: items.length, costUsd: 0 };
  } catch (e) {
    activityRuns.inc({ activity: "callRssRead", outcome: "error" });
    activityDuration.observe(
      { activity: "callRssRead" },
      secondsSince(startedAt),
    );
    if (e instanceof ApplicationFailure) throw e;
    if (e instanceof BlockedEgressError) {
      throw ApplicationFailure.nonRetryable(e.message, "EGRESS_BLOCKED");
    }
    // Fetch/parse failure — the feed URL is non-secret, so a sanitized retryable is fine.
    throw toSanitizedRetryable(e, "RSS_READ_ERROR");
  }
}

/** Change-detection state for a pollTrigger, keyed by (tenant, env, workflow, node) so it
 *  persists across the scheduled runs (NOT executionId, which changes each run). */
export interface PollMeta {
  tenantId: string;
  /** Absent for a legacy in-flight run started before env-scoped schedules — the cursor
   *  falls back to the tenant's default env (the 5b/6b precedent, see readChannels). */
  environmentId?: string;
  workflowKey: string;
  nodeId: string;
}
export interface PollResult {
  status: "ok";
  changed: boolean;
  body: unknown;
  costUsd: number;
}

const DEFAULT_POLL_TIMEOUT_MS = 15_000;
const MAX_POLL_TIMEOUT_MS = 30_000;

// Test seam: egress fetch + the cursor read/write, swappable in unit tests.
export const __pollDeps = {
  fetch: (url: string, init?: RequestInit) =>
    safeFetch(url, init as never) as unknown as Promise<Response>,
  assertEgressAllowed,
  readCursor: async (meta: PollMeta): Promise<string | null> => {
    // Legacy in-flight runs (started pre-env-scoped-schedules) carry no env — resolve the
    // default env IN THE ACTIVITY (workflow code stays deterministic; 6b readChannels precedent).
    const environmentId =
      meta.environmentId ?? (await getDefaultEnvironmentId(meta.tenantId));
    return getPrisma()
      .pollState.findUnique({
        where: {
          tenantId_environmentId_workflowKey_nodeId: {
            tenantId: meta.tenantId,
            environmentId,
            workflowKey: meta.workflowKey,
            nodeId: meta.nodeId,
          },
        },
      })
      .then((r) => r?.lastKey ?? null);
  },
  writeCursor: async (meta: PollMeta, lastKey: string): Promise<void> => {
    const environmentId =
      meta.environmentId ?? (await getDefaultEnvironmentId(meta.tenantId));
    await getPrisma().pollState.upsert({
      where: {
        tenantId_environmentId_workflowKey_nodeId: {
          tenantId: meta.tenantId,
          environmentId,
          workflowKey: meta.workflowKey,
          nodeId: meta.nodeId,
        },
      },
      create: {
        tenantId: meta.tenantId,
        environmentId,
        workflowKey: meta.workflowKey,
        nodeId: meta.nodeId,
        lastKey,
      },
      update: { lastKey },
    });
  },
};

/**
 * pollTrigger node — fetch a URL and report whether the source CHANGED since the last
 * poll. The change key is the configured JSON path (or the whole body) hashed; it is
 * compared to a persisted per-(tenant, workflow, node) cursor and the cursor is
 * advanced. Side-effecting (egress + DB), so it's an activity. The URL is non-secret.
 * On the FIRST poll (no cursor) `changed` is true so the flow runs once to seed.
 */
export async function callPoll(
  cfg: PollTriggerNodeConfig,
  meta: PollMeta,
): Promise<PollResult> {
  const startedAt = process.hrtime.bigint();
  try {
    await __pollDeps.assertEgressAllowed(cfg.url); // https + public host (SSRF guard)
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      Math.min(DEFAULT_POLL_TIMEOUT_MS, MAX_POLL_TIMEOUT_MS),
    );
    let text: string;
    try {
      const res = await __pollDeps.fetch(cfg.url, {
        signal: controller.signal,
      });
      text = await res.text();
    } finally {
      clearTimeout(timer);
    }

    // Parse JSON when possible so `changeKey` can select a field + the body is usable
    // downstream; fall back to the raw text.
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* not JSON — keep the text body */
    }

    // The change value: a selected path, or the whole body. Hash it to a compact,
    // storable key (avoids persisting large payloads in PollState).
    const value = cfg.changeKey
      ? getByPath(body, cfg.changeKey)
      : (body ?? text);
    const key = createHash("sha256")
      .update(typeof value === "string" ? value : JSON.stringify(value ?? null))
      .digest("hex");

    const previous = await __pollDeps.readCursor(meta);
    const changed = previous !== key; // first poll (previous null) ⇒ changed
    if (changed) await __pollDeps.writeCursor(meta, key);

    activityRuns.inc({ activity: "callPoll", outcome: "ok" });
    activityDuration.observe({ activity: "callPoll" }, secondsSince(startedAt));
    return { status: "ok", changed, body, costUsd: 0 };
  } catch (e) {
    activityRuns.inc({ activity: "callPoll", outcome: "error" });
    activityDuration.observe({ activity: "callPoll" }, secondsSince(startedAt));
    if (e instanceof ApplicationFailure) throw e;
    if (e instanceof BlockedEgressError) {
      throw ApplicationFailure.nonRetryable(e.message, "EGRESS_BLOCKED");
    }
    throw toSanitizedRetryable(e, "POLL_ERROR");
  }
}
