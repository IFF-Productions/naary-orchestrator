// Pure data-transform nodes: htmlExtract / markdown / random / encode / csv / xml.
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { ApplicationFailure } from "@temporalio/activity";
import { XMLBuilder, XMLParser } from "fast-xml-parser";
import { parse as parseHtml } from "node-html-parser";
import Papa from "papaparse";
import {
  getObjectStore,
  maybeOffload,
  resolveClaimChecks,
} from "@naary/storage";
import { activityDuration, activityRuns, secondsSince } from "../../metrics";
import type { AgentMeta } from "./shared";

export interface XmlConfig {
  operation: "parse" | "build";
}
export interface XmlResult {
  status: "ok";
  result: unknown;
  costUsd: number;
}

/**
 * xml node — parse an XML string → object, or build an object → XML string. Pure
 * transform (no secrets, no egress), but runs in an activity to keep the parser out
 * of the deterministic workflow bundle. Claim-checked input is rehydrated first; a
 * large result is offloaded.
 */
export interface HtmlExtraction {
  key: string;
  selector: string;
  return?: "text" | "html" | "attribute";
  attribute?: string;
  all?: boolean;
}
export interface HtmlExtractConfig {
  extractions: HtmlExtraction[];
}
export interface HtmlExtractResult {
  status: "ok";
  result: Record<string, unknown>;
  costUsd: number;
}

/**
 * htmlExtract node — pull values out of an HTML string with CSS selectors. Pure transform
 * (no secrets, no egress — the fetch is a separate httpRequest node), but runs in an activity
 * to keep the HTML parser out of the deterministic workflow bundle (like callXml). Each
 * extraction reads a matched element's text / inner HTML / attribute; `all` returns every
 * match. Claim-checked input is rehydrated first; a large result is offloaded.
 */
export async function callHtmlExtract(
  cfg: HtmlExtractConfig,
  input: unknown,
  meta: AgentMeta,
): Promise<HtmlExtractResult> {
  const startedAt = process.hrtime.bigint();
  const store = getObjectStore();
  const value = await resolveClaimChecks(input, store);
  try {
    const root = parseHtml(String(value));
    const readEl = (
      el: ReturnType<typeof root.querySelector>,
      ex: HtmlExtraction,
    ): string | null => {
      if (!el) return null;
      if (ex.return === "html") return el.innerHTML;
      if (ex.return === "attribute")
        return el.getAttribute(ex.attribute ?? "") ?? null;
      return el.text.trim();
    };
    const out: Record<string, unknown> = {};
    for (const ex of cfg.extractions ?? []) {
      if (!ex.key || !ex.selector) continue;
      out[ex.key] = ex.all
        ? root.querySelectorAll(ex.selector).map((el) => readEl(el, ex))
        : readEl(root.querySelector(ex.selector), ex);
    }
    const offloaded = await maybeOffload(out, store, {
      keyPrefix: `html/${meta.tenantId}`,
    });
    activityRuns.inc({ activity: "callHtmlExtract", outcome: "ok" });
    activityDuration.observe(
      { activity: "callHtmlExtract" },
      secondsSince(startedAt),
    );
    return {
      status: "ok",
      result: offloaded as Record<string, unknown>,
      costUsd: 0,
    };
  } catch {
    activityRuns.inc({ activity: "callHtmlExtract", outcome: "error" });
    activityDuration.observe(
      { activity: "callHtmlExtract" },
      secondsSince(startedAt),
    );
    throw ApplicationFailure.nonRetryable("HTML extract failed", "HTML_ERROR");
  }
}

export interface MarkdownResult {
  status: "ok";
  result: Record<string, unknown>;
  costUsd: number;
}

/**
 * markdown node — convert an HTML string to Markdown. Pure transform (no secrets, no egress), but
 * runs in an activity to keep the HTML parser out of the deterministic workflow bundle (like
 * callHtmlExtract). Covers the common tags (headings, p, br, strong/em, a, ul/ol/li, code/pre,
 * blockquote, hr); unknown tags fall through to their children's text. Not a full CommonMark
 * round-trip — a pragmatic converter for feeding scraped HTML to an agent as clean Markdown.
 */
export async function callMarkdown(
  input: unknown,
  meta: AgentMeta,
): Promise<MarkdownResult> {
  const startedAt = process.hrtime.bigint();
  const store = getObjectStore();
  const value = await resolveClaimChecks(input, store);
  try {
    const markdown = htmlToMarkdown(String(value ?? ""));
    const offloaded = await maybeOffload({ markdown }, store, {
      keyPrefix: `md/${meta.tenantId}`,
    });
    activityRuns.inc({ activity: "callMarkdown", outcome: "ok" });
    activityDuration.observe(
      { activity: "callMarkdown" },
      secondsSince(startedAt),
    );
    return {
      status: "ok",
      result: offloaded as Record<string, unknown>,
      costUsd: 0,
    };
  } catch {
    activityRuns.inc({ activity: "callMarkdown", outcome: "error" });
    activityDuration.observe(
      { activity: "callMarkdown" },
      secondsSince(startedAt),
    );
    throw ApplicationFailure.nonRetryable(
      "Markdown conversion failed",
      "MARKDOWN_ERROR",
    );
  }
}

/** Pure HTML→Markdown conversion (exported for unit tests; the activity wraps it with the store).
 *  Common-tag subset — not a full CommonMark round-trip. */
export function htmlToMarkdown(html: string): string {
  return normalizeMarkdown(htmlNodeToMarkdown(parseHtml(html) as HtmlNodeLike));
}

/** Minimal node shape from node-html-parser we rely on (avoids importing its classes). */
interface HtmlNodeLike {
  nodeType: number; // 1 = element, 3 = text
  rawTagName?: string;
  rawText?: string;
  text?: string;
  childNodes?: HtmlNodeLike[];
  getAttribute?: (name: string) => string | null | undefined;
}

/** Recursively render a parsed HTML node to Markdown (common-tag subset). */
function htmlNodeToMarkdown(node: HtmlNodeLike): string {
  if (node.nodeType === 3) {
    // Text node — collapse internal whitespace (block structure adds the newlines).
    return String(node.rawText ?? node.text ?? "").replace(/\s+/g, " ");
  }
  const kids = () => (node.childNodes ?? []).map(htmlNodeToMarkdown).join("");
  const tag = (node.rawTagName ?? "").toLowerCase();
  switch (tag) {
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6":
      return `\n\n${"#".repeat(Number(tag[1]))} ${kids().trim()}\n\n`;
    case "p":
    case "div":
    case "section":
    case "article":
      return `\n\n${kids().trim()}\n\n`;
    case "br":
      return "  \n";
    case "hr":
      return "\n\n---\n\n";
    case "strong":
    case "b":
      return `**${kids().trim()}**`;
    case "em":
    case "i":
      return `_${kids().trim()}_`;
    case "code":
      return `\`${(node.text ?? "").trim()}\``;
    case "pre":
      return `\n\n\`\`\`\n${(node.text ?? "").replace(/\s+$/, "")}\n\`\`\`\n\n`;
    case "a": {
      const href = node.getAttribute?.("href");
      const label = kids().trim();
      return href ? `[${label}](${href})` : label;
    }
    case "blockquote":
      return `\n\n> ${kids().trim().replace(/\n+/g, "\n> ")}\n\n`;
    case "ul":
      return `\n\n${renderList(node, false)}\n\n`;
    case "ol":
      return `\n\n${renderList(node, true)}\n\n`;
    case "li":
      return kids().trim(); // list markers are added by renderList
    default:
      return kids();
  }
}

/** Render <ul>/<ol> children <li> as a bulleted/numbered Markdown list. */
function renderList(node: HtmlNodeLike, ordered: boolean): string {
  const items = (node.childNodes ?? []).filter(
    (c) => (c.rawTagName ?? "").toLowerCase() === "li",
  );
  return items
    .map((li, i) => {
      const marker = ordered ? `${i + 1}. ` : "- ";
      return `${marker}${htmlNodeToMarkdown(li).trim()}`;
    })
    .join("\n");
}

/** Collapse the extra whitespace the block rules emit into tidy Markdown. */
function normalizeMarkdown(s: string): string {
  return s
    .replace(/[ \t]+\n/g, "\n") // strip trailing spaces (a <br> becomes a plain newline)
    .replace(/\n{3,}/g, "\n\n") // at most one blank line between blocks
    .replace(/[ \t]{2,}(?=\S)/g, " ") // collapse runs of spaces before text
    .trim();
}

export interface RandomConfig {
  operation: "uuid" | "hex" | "base64" | "alphanumeric" | "int";
  length?: number;
  min?: number;
  max?: number;
}
export interface RandomResult {
  status: "ok";
  value: string | number;
  costUsd: number;
}

const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/**
 * random node — generate a fresh random value. In an activity because randomness is
 * non-deterministic (Math.random/randomBytes must never run in workflow code). No secrets.
 */
export async function callRandom(
  cfg: RandomConfig,
  meta: AgentMeta,
): Promise<RandomResult> {
  const startedAt = process.hrtime.bigint();
  try {
    const len = Math.min(1024, Math.max(1, Math.floor(cfg.length ?? 16)));
    let value: string | number;
    switch (cfg.operation) {
      case "uuid":
        value = randomUUID();
        break;
      case "hex":
        value = randomBytes(len).toString("hex");
        break;
      case "base64":
        value = randomBytes(len).toString("base64url");
        break;
      case "alphanumeric": {
        const bytes = randomBytes(len);
        let out = "";
        for (let i = 0; i < len; i++) out += ALNUM[bytes[i] % ALNUM.length];
        value = out;
        break;
      }
      case "int": {
        const min = Math.floor(cfg.min ?? 0);
        const max = Math.floor(cfg.max ?? 100);
        // randomInt's upper bound is exclusive; make [min, max] inclusive. Guard min<=max.
        value = max <= min ? min : randomInt(min, max + 1);
        break;
      }
      default:
        value = "";
    }
    activityRuns.inc({ activity: "callRandom", outcome: "ok" });
    activityDuration.observe(
      { activity: "callRandom" },
      secondsSince(startedAt),
    );
    return { status: "ok", value, costUsd: 0 };
  } catch {
    activityRuns.inc({ activity: "callRandom", outcome: "error" });
    activityDuration.observe(
      { activity: "callRandom" },
      secondsSince(startedAt),
    );
    throw ApplicationFailure.nonRetryable(
      "Random generate failed",
      "RANDOM_ERROR",
    );
  }
}

export interface EncodeConfig {
  operation:
    | "base64Encode"
    | "base64Decode"
    | "base64urlEncode"
    | "base64urlDecode"
    | "hexEncode"
    | "hexDecode"
    | "urlEncode"
    | "urlDecode";
}
export interface EncodeResult {
  status: "ok";
  result: string;
  costUsd: number;
}

/**
 * encode node — string ↔ base64 / base64url / hex / URL. In an activity because base64/hex
 * use Node's Buffer (not in the deterministic workflow bundle). Claim-checked input is
 * rehydrated first; malformed input (e.g. bad hex) is the user's data problem → non-retryable.
 */
export async function callEncode(
  cfg: EncodeConfig,
  input: unknown,
  meta: AgentMeta,
): Promise<EncodeResult> {
  const startedAt = process.hrtime.bigint();
  const store = getObjectStore();
  const s = String((await resolveClaimChecks(input, store)) ?? "");
  try {
    let result: string;
    switch (cfg.operation) {
      case "base64Encode":
        result = Buffer.from(s, "utf8").toString("base64");
        break;
      case "base64Decode":
        result = Buffer.from(s, "base64").toString("utf8");
        break;
      case "base64urlEncode":
        result = Buffer.from(s, "utf8").toString("base64url");
        break;
      case "base64urlDecode":
        result = Buffer.from(s, "base64url").toString("utf8");
        break;
      case "hexEncode":
        result = Buffer.from(s, "utf8").toString("hex");
        break;
      case "hexDecode":
        result = Buffer.from(s, "hex").toString("utf8");
        break;
      case "urlEncode":
        result = encodeURIComponent(s);
        break;
      case "urlDecode":
        result = decodeURIComponent(s);
        break;
      default:
        result = s;
    }
    activityRuns.inc({ activity: "callEncode", outcome: "ok" });
    activityDuration.observe(
      { activity: "callEncode" },
      secondsSince(startedAt),
    );
    return { status: "ok", result, costUsd: 0 };
  } catch {
    activityRuns.inc({ activity: "callEncode", outcome: "error" });
    activityDuration.observe(
      { activity: "callEncode" },
      secondsSince(startedAt),
    );
    throw ApplicationFailure.nonRetryable("Encode failed", "ENCODE_ERROR");
  }
}

export interface CsvConfig {
  operation: "parse" | "build";
  header?: boolean;
  delimiter?: string;
}
export interface CsvResult {
  status: "ok";
  result: unknown;
  costUsd: number;
}

/**
 * csv node — parse CSV text → rows, or build rows → CSV text. Pure transform (no secrets,
 * no egress), in an activity to keep the parser out of the deterministic workflow bundle
 * (like callXml). `header` (default true) uses/emits a header row. Claim-checked input is
 * rehydrated; a large result is offloaded; malformed input is the user's data problem.
 */
export async function callCsv(
  cfg: CsvConfig,
  input: unknown,
  meta: AgentMeta,
): Promise<CsvResult> {
  const startedAt = process.hrtime.bigint();
  const store = getObjectStore();
  const value = await resolveClaimChecks(input, store);
  const header = cfg.header !== false;
  const delimiter = cfg.delimiter || ",";
  try {
    let result: unknown;
    if (cfg.operation === "build") {
      const rows = Array.isArray(value) ? value : [value];
      result = { csv: Papa.unparse(rows as object[], { header, delimiter }) };
    } else {
      const parsed = Papa.parse(String(value), {
        header,
        delimiter,
        skipEmptyLines: true,
      });
      result = parsed.data;
    }
    const offloaded = await maybeOffload(result, store, {
      keyPrefix: `csv/${meta.tenantId}`,
    });
    activityRuns.inc({ activity: "callCsv", outcome: "ok" });
    activityDuration.observe({ activity: "callCsv" }, secondsSince(startedAt));
    return { status: "ok", result: offloaded, costUsd: 0 };
  } catch {
    activityRuns.inc({ activity: "callCsv", outcome: "error" });
    activityDuration.observe({ activity: "callCsv" }, secondsSince(startedAt));
    throw ApplicationFailure.nonRetryable(
      `CSV ${cfg.operation} failed`,
      "CSV_ERROR",
    );
  }
}

export async function callXml(
  cfg: XmlConfig,
  input: unknown,
  meta: AgentMeta,
): Promise<XmlResult> {
  const startedAt = process.hrtime.bigint();
  const store = getObjectStore();
  const value = await resolveClaimChecks(input, store);
  try {
    let result: unknown;
    if (cfg.operation === "build") {
      const xml = new XMLBuilder({
        ignoreAttributes: false,
        format: true,
      }).build(value);
      result = { xml };
    } else {
      result = new XMLParser({ ignoreAttributes: false }).parse(String(value));
    }
    const offloaded = await maybeOffload(result, store, {
      keyPrefix: `xml/${meta.tenantId}`,
    });
    activityRuns.inc({ activity: "callXml", outcome: "ok" });
    activityDuration.observe({ activity: "callXml" }, secondsSince(startedAt));
    return { status: "ok", result: offloaded, costUsd: 0 };
  } catch {
    activityRuns.inc({ activity: "callXml", outcome: "error" });
    activityDuration.observe({ activity: "callXml" }, secondsSince(startedAt));
    // Parser/builder errors are the user's data problem — non-retryable, no secrets.
    throw ApplicationFailure.nonRetryable(
      `XML ${cfg.operation} failed`,
      "XML_ERROR",
    );
  }
}
