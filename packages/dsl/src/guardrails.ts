/**
 * AGENT GUARDRAILS (#576) — the PURE policy layer.
 *
 * Four capabilities, one policy object stored per workspace on `TenantSettings.agentGuardrails`:
 *   1. tool allow/deny-list      — which MCP tools / integration actions a graph may call
 *   2. forced-approval tools     — a tool whose call must be approved by a human first
 *   3. input/output content rules — keyword/regex blocklists on what goes to / comes from the model
 *   4. PII redaction             — a pre-call pass over the prompt
 *
 * WHY THIS FILE IS PURE (CLAUDE.md Tier-1 rule 2): the tool-policy evaluator is reachable from
 * DETERMINISTIC WORKFLOW CODE (the interpreter's forced-approval gate) and from the API save gate
 * and from the agent activity. So: no zod, no I/O, no clock, no randomness, no `new Function`.
 * The zod SCHEMA for this shape lives in `./registry` (which is deliberately NOT re-exported from
 * the package index, keeping zod out of the workflow bundle).
 *
 * WHY THE REDACTION MAP NEVER LEAVES: {@link redactPii} returns `{ text, map }`. The map is
 * placeholder → RAW PII. It exists only so repeated occurrences of one value get one stable
 * placeholder (coherence for the model). Tier-1 rule 4's posture applies to it verbatim: the
 * caller must use it in memory and drop it — never return it from an activity, never log it,
 * never put it in a span, never persist it. The agent activity is the only caller.
 */
import { hasNestedQuantifier } from "./branch";
import type { GraphDef, NodeType } from "./types";

// ---------------------------------------------------------------------------------------------
// Policy shape
// ---------------------------------------------------------------------------------------------

/** What the policy says about one tool reference. */
export type ToolPolicyVerdict = "allow" | "deny" | "approval";

/**
 * Tool allow/deny/forced-approval lists. Entries are GLOBS (`*` = any run of characters), never
 * regexes — an operator-authored regex here would be a ReDoS surface in workflow code for no
 * expressive gain.
 *
 * MATCH TARGET: a pattern CONTAINING `:` is matched against the full ref (`connectionId:tool` for
 * MCP, `provider:action` for an integration); a pattern WITHOUT `:` is matched against the tool /
 * action segment alone. So `"delete_*"` covers that tool on every connection, while
 * `"conn_abc:delete_*"` scopes it to one server.
 */
export interface ToolPolicy {
  /** Absent/empty ⇒ every tool is allowed (subject to `deny`). Non-empty ⇒ ALLOWLIST: a ref that
   *  matches nothing here is denied. */
  allow?: string[];
  /** A match denies. Deny beats allow and beats requireApproval — it is the final word. */
  deny?: string[];
  /** A match requires a human approval before the call executes. */
  requireApproval?: string[];
}

/** What to do when a content rule matches. `fail` = fail the node non-retryably; `strip` = replace
 *  the matched text with {@link BLOCKED_PLACEHOLDER} and continue. */
export type ContentRuleAction = "fail" | "strip";

/** One content rule. `label` is the ONLY thing that reaches an audit row / error message — never
 *  the matched text, which is by definition the sensitive part. */
export interface ContentRule {
  /** Short operator-chosen name, e.g. "internal-codename". Appears in audit + node error. */
  label: string;
  kind: "keyword" | "regex";
  /** Literal substring (`keyword`) or JS regex source (`regex`, no flags/delimiters). */
  pattern: string;
  /** Default "fail". */
  action?: ContentRuleAction;
  /** Default true for `keyword`, false for `regex`. */
  ignoreCase?: boolean;
}

/**
 * PII classes the redaction pass recognizes, in the ORDER they are applied (see
 * {@link PII_MATCHERS}: cards/SSNs must be matched before the looser phone shape). A literal
 * tuple so the registry's zod schema can `z.enum` it without drifting from the type.
 */
export const PII_KIND_VALUES = [
  "creditCard",
  "ssn",
  "email",
  "ipv4",
  "phone",
] as const;

export type PiiKind = (typeof PII_KIND_VALUES)[number];

export const PII_KINDS: readonly PiiKind[] = PII_KIND_VALUES;

/** The whole per-workspace policy. Every field optional ⇒ `{}` is "no guardrails" and is
 *  byte-identical in behaviour to having no policy row at all. */
export interface AgentGuardrailPolicy {
  tools?: ToolPolicy;
  /** Rules applied to the assembled PROMPT (system prompt + serialized input). */
  input?: ContentRule[];
  /** Rules applied to the model's OUTPUT (serialized) before it becomes the node output. */
  output?: ContentRule[];
  /** Pre-call PII redaction of the prompt. Off unless `enabled`. */
  redact?: {
    enabled?: boolean;
    /** Absent ⇒ all of {@link PII_KINDS}. */
    kinds?: PiiKind[];
  };
}

/** An empty policy — the shared "nothing configured" value. */
export const EMPTY_GUARDRAIL_POLICY: AgentGuardrailPolicy = {};

/** True when the policy asks for nothing at all (lets every caller skip its work entirely). */
export function isEmptyGuardrailPolicy(
  p: AgentGuardrailPolicy | undefined,
): boolean {
  if (!p) return true;
  const t = p.tools;
  const toolsEmpty =
    !t ||
    ((t.allow?.length ?? 0) === 0 &&
      (t.deny?.length ?? 0) === 0 &&
      (t.requireApproval?.length ?? 0) === 0);
  return (
    toolsEmpty &&
    (p.input?.length ?? 0) === 0 &&
    (p.output?.length ?? 0) === 0 &&
    p.redact?.enabled !== true
  );
}

// ---------------------------------------------------------------------------------------------
// Tool references + policy evaluation
// ---------------------------------------------------------------------------------------------

/** Node types that can invoke a tool and are therefore governed by {@link ToolPolicy}. */
export const TOOL_BEARING_NODE_TYPES: readonly NodeType[] = [
  "agent",
  "mcpTool",
  "integration",
] as const;

/** The canonical ref for an MCP tool call. */
export function mcpToolRef(connectionId: string, tool: string): string {
  return `${connectionId}:${tool}`;
}

/** The canonical ref for a native integration action. */
export function integrationToolRef(provider: string, action: string): string {
  return `${provider}:${action}`;
}

/** Everything after the FIRST `:` — the tool/action segment a colon-less pattern matches against.
 *  (A connectionId is a uuid and never contains `:`.) */
function refTail(ref: string): string {
  const i = ref.indexOf(":");
  return i === -1 ? ref : ref.slice(i + 1);
}

/**
 * Anchored glob match. `*` → "any run of characters"; every other character is a LITERAL (regex
 * metacharacters are escaped), so an operator pattern can never become an injected regex or a
 * backtracking bomb — the generated source has no nested quantifiers by construction.
 */
export function matchToolPattern(pattern: string, ref: string): boolean {
  const target = pattern.includes(":") ? ref : refTail(ref);
  const source = pattern
    .split("*")
    .map((lit) => lit.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[\\s\\S]*");
  return new RegExp(`^${source}$`).test(target);
}

function matchesAny(patterns: string[] | undefined, ref: string): boolean {
  return (patterns ?? []).some((p) => matchToolPattern(p, ref));
}

/**
 * The verdict for one tool ref. Evaluation order is deliberate and is the security contract:
 *   1. `deny` — an explicit deny is FINAL (it beats an allowlist entry and beats requireApproval;
 *      a denied tool must never be reachable by getting a human to click Approve).
 *   2. a non-empty `allow` list is an ALLOWLIST — no match ⇒ deny (fail closed).
 *   3. `requireApproval` ⇒ "approval".
 *   4. otherwise allow.
 */
export function evaluateToolPolicy(
  ref: string,
  policy: AgentGuardrailPolicy | undefined,
): ToolPolicyVerdict {
  const t = policy?.tools;
  if (!t) return "allow";
  if (matchesAny(t.deny, ref)) return "deny";
  if ((t.allow?.length ?? 0) > 0 && !matchesAny(t.allow, ref)) return "deny";
  if (matchesAny(t.requireApproval, ref)) return "approval";
  return "allow";
}

/** One tool reference found in a graph, with the node (and, for an agent, the exposed tool name)
 *  that carries it — so a save-gate error can name the exact place to fix. */
export interface GraphToolRef {
  nodeId: string;
  nodeType: NodeType;
  ref: string;
  /** For an agent node's in-loop tool: the name exposed to the model. */
  exposedName?: string;
}

/**
 * Every tool ref a graph can invoke, in a DETERMINISTIC order (graph node order, then the node's
 * own tool order) — the interpreter turns this into one activity call, so the order must replay.
 */
export function graphToolRefs(graph: {
  nodes: { id: string; type: NodeType; config?: Record<string, unknown> }[];
}): GraphToolRef[] {
  const out: GraphToolRef[] = [];
  for (const node of graph.nodes) {
    const cfg = (node.config ?? {}) as Record<string, unknown>;
    if (node.type === "agent") {
      const tools = Array.isArray(cfg.tools) ? cfg.tools : [];
      for (const raw of tools) {
        const t = (raw ?? {}) as Record<string, unknown>;
        if (typeof t.connectionId !== "string" || typeof t.tool !== "string")
          continue;
        out.push({
          nodeId: node.id,
          nodeType: node.type,
          ref: mcpToolRef(t.connectionId, t.tool),
          exposedName:
            typeof t.name === "string" && t.name.trim()
              ? t.name.trim()
              : t.tool,
        });
      }
    } else if (node.type === "mcpTool") {
      if (
        typeof cfg.connectionId === "string" &&
        typeof cfg.tool === "string"
      ) {
        out.push({
          nodeId: node.id,
          nodeType: node.type,
          ref: mcpToolRef(cfg.connectionId, cfg.tool),
        });
      }
    } else if (node.type === "integration") {
      if (typeof cfg.provider === "string" && typeof cfg.action === "string") {
        out.push({
          nodeId: node.id,
          nodeType: node.type,
          ref: integrationToolRef(cfg.provider, cfg.action),
        });
      }
    }
  }
  return out;
}

/** Distinct refs from {@link graphToolRefs}, first-seen order preserved (deterministic). */
export function distinctToolRefs(refs: GraphToolRef[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of refs) {
    if (!seen.has(r.ref)) {
      seen.add(r.ref);
      out.push(r.ref);
    }
  }
  return out;
}

/** One save-gate rejection: a node whose tool the workspace policy forbids. */
export interface ToolPolicyError {
  nodeId: string;
  nodeType: NodeType;
  ref: string;
  reason: "denied" | "approval-in-agent-loop";
  message: string;
}

/**
 * SAVE GATE (#576 AC1, first half). Rejects, per node:
 *   - a DENIED tool anywhere; and
 *   - a forced-approval tool inside an AGENT node's in-loop `tools[]`.
 *
 * The second rule is the honest consequence of the activity boundary: an agent's tool calls happen
 * INSIDE one activity, and Temporal cannot suspend an activity to await a Signal — so a durable
 * pause is only possible where the interpreter owns the call, i.e. a standalone `mcpTool` /
 * `integration` node. Rather than silently downgrade a forced-approval tool to "just run it" (a
 * governance hole) or fake the pause with a poll, the save gate refuses the configuration and says
 * what to do instead. See docs/design/AGENT-GUARDRAILS.md §4.
 */
export function validateGraphToolPolicy(
  graph: {
    nodes: { id: string; type: NodeType; config?: Record<string, unknown> }[];
  },
  policy: AgentGuardrailPolicy | undefined,
): ToolPolicyError[] {
  if (!policy?.tools) return [];
  const errors: ToolPolicyError[] = [];
  for (const r of graphToolRefs(graph)) {
    const verdict = evaluateToolPolicy(r.ref, policy);
    if (verdict === "deny") {
      errors.push({
        nodeId: r.nodeId,
        nodeType: r.nodeType,
        ref: r.ref,
        reason: "denied",
        message: `tool '${r.ref}' is blocked by this workspace's agent guardrail policy`,
      });
    } else if (verdict === "approval" && r.nodeType === "agent") {
      errors.push({
        nodeId: r.nodeId,
        nodeType: r.nodeType,
        ref: r.ref,
        reason: "approval-in-agent-loop",
        message:
          `tool '${r.ref}' requires human approval, which cannot be awaited inside an agent's ` +
          `tool loop — move it to a standalone Tool/Integration node (the run pauses before it)`,
      });
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------------------------
// Content rules
// ---------------------------------------------------------------------------------------------

/** What a stripped match is replaced with. */
export const BLOCKED_PLACEHOLDER = "[BLOCKED]";

/** Bound on an operator regex's SOURCE length (mirrors the edge-condition ReDoS guard). */
export const MAX_CONTENT_RULE_PATTERN_LENGTH = 250;

/**
 * Bound on how much text a REGEX rule is scanned over. The structural nested-quantifier guard
 * below catches the `(a+)+` family but not every exponential shape (e.g. `(a|a)*b`), and no
 * timeout can interrupt a synchronous RegExp — so we also bound the input. 100k chars is far
 * above any realistic prompt; a `keyword` rule has NO cap (`indexOf` is linear and safe), so an
 * operator who needs an unbounded scan should use a keyword rule.
 */
export const MAX_CONTENT_SCAN_CHARS = 100_000;

/** A rule that matched. Carries the LABEL only — never the matched text. */
export interface ContentViolation {
  label: string;
  action: ContentRuleAction;
  /** Number of matches (a count is not content). */
  matches: number;
}

export interface ContentRuleResult {
  /** The text after `strip` rules were applied (unchanged when nothing stripped). */
  text: string;
  violations: ContentViolation[];
  /** True when at least one `fail` rule matched — the caller must fail the node. */
  blocked: boolean;
}

/** Compile a rule to a global RegExp, or undefined when the rule is unusable/unsafe. Unsafe and
 *  invalid patterns are treated as NON-matching (never as a silent allow-everything). */
function compileRule(rule: ContentRule): RegExp | undefined {
  const flags = `g${(rule.ignoreCase ?? rule.kind === "keyword") ? "i" : ""}`;
  if (rule.kind === "keyword") {
    if (!rule.pattern) return undefined;
    return new RegExp(
      rule.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      flags,
    );
  }
  if (
    !rule.pattern ||
    rule.pattern.length > MAX_CONTENT_RULE_PATTERN_LENGTH ||
    hasNestedQuantifier(rule.pattern)
  ) {
    return undefined;
  }
  try {
    return new RegExp(rule.pattern, flags);
  } catch {
    return undefined; // invalid source → never matches (does not open the gate)
  }
}

/**
 * Apply content rules to a string. PURE. `fail` rules only report (the caller decides how to fail,
 * so the same function serves the input and output sides); `strip` rules rewrite the text.
 */
export function applyContentRules(
  text: string,
  rules: ContentRule[] | undefined,
): ContentRuleResult {
  if (!rules?.length) return { text, violations: [], blocked: false };
  let out = text;
  const violations: ContentViolation[] = [];
  for (const rule of rules) {
    const re = compileRule(rule);
    if (!re) continue;
    const scanned =
      rule.kind === "regex" && out.length > MAX_CONTENT_SCAN_CHARS
        ? out.slice(0, MAX_CONTENT_SCAN_CHARS)
        : out;
    const matches = scanned.match(re);
    if (!matches?.length) continue;
    const action = rule.action ?? "fail";
    violations.push({ label: rule.label, action, matches: matches.length });
    if (action === "strip") {
      // Re-run over the SCANNED slice and splice the untouched tail back, so a regex rule can
      // never rewrite text it was not allowed to scan.
      re.lastIndex = 0;
      out =
        scanned.replace(re, BLOCKED_PLACEHOLDER) +
        (scanned.length < out.length ? out.slice(scanned.length) : "");
    }
  }
  return {
    text: out,
    violations,
    blocked: violations.some((v) => v.action === "fail"),
  };
}

/**
 * Apply content rules to every STRING LEAF of an arbitrary value (the agent's structured output).
 *
 * Why leaf-wise instead of stringify → rules → parse: a `strip` rule whose match straddled a JSON
 * delimiter (`","`) would produce text that no longer parses, silently destroying the node's
 * output. Walking leaves means a rule can only ever rewrite the inside of a string value.
 * Bounded depth + cycle-safe, mirroring @naary/observability's deepScrub.
 */
export function applyContentRulesToValue<T>(
  value: T,
  rules: ContentRule[] | undefined,
): { value: T; violations: ContentViolation[]; blocked: boolean } {
  if (!rules?.length) return { value, violations: [], blocked: false };
  const violations: ContentViolation[] = [];
  const walk = (v: unknown, depth: number, seen: WeakSet<object>): unknown => {
    if (depth > 8 || v == null) return v;
    if (typeof v === "string") {
      const r = applyContentRules(v, rules);
      violations.push(...r.violations);
      return r.text;
    }
    if (typeof v !== "object") return v;
    if (seen.has(v as object)) return v;
    seen.add(v as object);
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1, seen));
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      out[k] = walk(x, depth + 1, seen);
    }
    return out;
  };
  const next = walk(value, 0, new WeakSet()) as T;
  return {
    value: next,
    violations,
    blocked: violations.some((x) => x.action === "fail"),
  };
}

/** Collapse violations to `"<side>:<label>"` strings — the ONLY violation detail safe to return
 *  from an activity / write to an audit row (a label is operator-chosen, never matched content). */
export function violationLabels(
  side: "input" | "output",
  violations: ContentViolation[],
): string[] {
  const seen = new Set<string>();
  for (const v of violations) seen.add(`${side}:${v.label}`);
  return [...seen];
}

// ---------------------------------------------------------------------------------------------
// PII redaction
// ---------------------------------------------------------------------------------------------

/** Luhn check — keeps the card matcher from eating every long digit run (order ids, timestamps). */
function luhnValid(digits: string): boolean {
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

/**
 * Per-kind matcher. ORDER MATTERS and is fixed by {@link PII_KINDS}: cards and SSNs are matched
 * BEFORE phone numbers, or the looser phone shape would swallow them and mislabel the placeholder.
 * `validate` rejects a structural match that isn't really an instance of the kind.
 */
const PII_MATCHERS: Record<
  PiiKind,
  { re: RegExp; validate?: (m: string) => boolean }
> = {
  // 13–19 digits, optionally grouped by single spaces/hyphens, Luhn-valid.
  creditCard: {
    re: /\b\d(?:[ -]?\d){12,18}\b/g,
    validate: (m) => luhnValid(m.replace(/[ -]/g, "")),
  },
  ssn: { re: /\b\d{3}-\d{2}-\d{4}\b/g },
  email: { re: /\b[A-Za-z0-9._%+'-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+\b/g },
  ipv4: {
    re: /\b\d{1,3}(?:\.\d{1,3}){3}\b/g,
    validate: (m) => m.split(".").every((o) => Number(o) <= 255),
  },
  // A loose international shape, then a digit-count check (8–15, the E.164 range).
  phone: {
    re: /\+?\d(?:[\d\s().-]{6,18})\d/g,
    validate: (m) => {
      const n = m.replace(/\D/g, "").length;
      return n >= 8 && n <= 15;
    },
  },
};

export interface RedactionResult {
  /** The redacted text — this is what may be sent to the model / logged / returned. */
  text: string;
  /**
   * placeholder → RAW PII. SENSITIVE: in-memory only, in the activity that produced it. Never
   * return it from an activity, never log it, never attach it to a span, never persist it
   * (CLAUDE.md Tier-1 rule 4 posture). Present so one value gets one stable placeholder.
   */
  map: Record<string, string>;
  /** How many distinct values were redacted (a count is safe to log). */
  count: number;
}

/**
 * Replace PII occurrences with stable `[PII_<KIND>_<n>]` placeholders. PURE + deterministic:
 * the same input yields the same placeholders (numbering follows first appearance per kind).
 *
 * The placeholder shape is deliberately free of the characters the phone/ipv4 matchers need, so a
 * later kind can never re-redact an earlier kind's placeholder.
 */
export function redactPii(text: string, kinds?: PiiKind[]): RedactionResult {
  const active = kinds?.length
    ? PII_KINDS.filter((k) => kinds.includes(k))
    : PII_KINDS;
  const map: Record<string, string> = {};
  const assigned = new Map<string, string>(); // raw → placeholder (stable across occurrences)
  let out = text;
  for (const kind of active) {
    const { re, validate } = PII_MATCHERS[kind];
    let n = 0;
    re.lastIndex = 0;
    out = out.replace(re, (m) => {
      if (validate && !validate(m)) return m;
      const existing = assigned.get(m);
      if (existing) return existing;
      n += 1;
      const placeholder = `[PII_${kind.toUpperCase()}_${n}]`;
      assigned.set(m, placeholder);
      map[placeholder] = m;
      return placeholder;
    });
  }
  return { text: out, map, count: Object.keys(map).length };
}

/** True when `text` still contains something the given kinds would redact — the assertion helper
 *  the AC3 test uses to prove a payload is PII-free. */
export function containsPii(text: string, kinds?: PiiKind[]): boolean {
  return redactPii(text, kinds).count > 0;
}

/** Does this graph reference any tool at all? Lets the interpreter skip the policy lookup
 *  entirely for a tool-free graph (pure, deterministic scan). */
export function graphHasToolNodes(graph: GraphDef): boolean {
  return graph.nodes.some((n) =>
    (TOOL_BEARING_NODE_TYPES as readonly string[]).includes(n.type),
  );
}
