/**
 * Per-node-type config translation for the n8n importer (#579).
 *
 * Split out of `n8n-import.ts` — that file owns the graph-shaped work (which nodes exist, how edges
 * and branch conditions are derived, what the report says); this one owns the mechanical job of
 * turning one n8n node's `parameters` blob into one of our node configs.
 *
 * Every branch here is deliberately conservative. It fills what maps cleanly, pushes a NOTE for
 * whatever it cannot, and leaves the rest to the user. That is the right failure mode for an
 * importer: the save gate is lenient on missing fields (`validateGraphConfigs` `.partial()`s each
 * schema), so an incomplete config is a saveable draft — whereas an invented value is a bug the
 * user has no way to notice.
 *
 * Pure + dependency-free, like the rest of the package.
 */
import {
  convertN8nExpression,
  convertN8nValueDeep,
  type UnconvertedExpression,
} from "./n8n-expressions";
import type { ConditionOp, EdgeCondition, NodeType } from "./types/core";

// ── small helpers ─────────────────────────────────────────────────────────────────────────────

export const asRecord = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};

export const asString = (v: unknown): string | undefined =>
  typeof v === "string" && v.length > 0 ? v : undefined;

const asNumber = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

/** n8n wraps many pickers in a "resource locator" (`{__rl: true, value, mode}`) rather than a bare
 *  string. Unwrap either shape so a model id / channel id / table id is read the same way. */
export const asPicked = (v: unknown): string | undefined =>
  asString(v) ?? asString(asRecord(v).value);

/** Name given to a Switch's synthesized fallback branch (n8n's `fallbackOutput: "extra"`). Shared
 *  with the importer, which gates that output's edge on `matched === this`. */
export const FALLBACK_RULE_NAME = "fallback";

/** n8n's comparison operators → ours. Unmapped ones fall back to `exists` + a note. */
const OP_MAP: Record<string, ConditionOp> = {
  equals: "eq",
  equal: "eq",
  notEquals: "neq",
  notEqual: "neq",
  contains: "contains",
  notContains: "notContains",
  startsWith: "startsWith",
  endsWith: "endsWith",
  regex: "regex",
  matchesRegex: "regex",
  gt: "gt",
  larger: "gt",
  gte: "gte",
  largerEqual: "gte",
  lt: "lt",
  smaller: "lt",
  lte: "lte",
  smallerEqual: "lte",
  isEmpty: "isEmpty",
  empty: "isEmpty",
  isNotEmpty: "notEmpty",
  notEmpty: "notEmpty",
  exists: "exists",
  true: "eq",
  false: "eq",
};

/**
 * Translate one n8n v2 filter condition (`{leftValue, rightValue, operator:{type, operation}}`) or
 * a v1 condition (`{value1, operation, value2}`) into an EdgeCondition.
 *
 * `path` is the load-bearing part: n8n's left side is an expression (`={{ $json.status }}`), and our
 * condition path is a plain ctx path — so we convert the expression and then strip the `{{ }}`.
 */
function toCondition(
  raw: unknown,
  predecessorId: string | null,
  nameToId: ReadonlyMap<string, string>,
  notes: string[],
): EdgeCondition {
  const c = asRecord(raw);
  const operator = asRecord(c.operator);
  const rawOp =
    asString(operator.operation) ?? asString(c.operation) ?? "exists";
  // Own-property lookup, not a bare index: the export is untrusted, and an operator named
  // `constructor`/`toString`/`valueOf` would otherwise return an INHERITED function — truthy, so the
  // `!op` fallback below never fires and `op` becomes a function. That serializes away to nothing,
  // handing the user a draft that fails the save gate on a field the report never mentioned.
  // (Same guard the rest of the importer uses for lookupN8nNode / N8N_APP_TO_PROVIDER.)
  const op = Object.prototype.hasOwnProperty.call(OP_MAP, rawOp)
    ? OP_MAP[rawOp]
    : undefined;
  if (!op) {
    notes.push(
      `condition operator '${rawOp}' has no equivalent — imported as 'exists', which is always true; fix the condition.`,
    );
  }
  const left = c.leftValue ?? c.value1 ?? "";
  const right = c.rightValue ?? c.value2;

  // The left side must become a bare ctx PATH. Convert the expression, then unwrap a whole-string
  // token; anything else can't be a path, so fall back to a note rather than a wrong path.
  let path = "";
  if (typeof left === "string") {
    const conv = convertN8nExpression(left, predecessorId, nameToId);
    const whole = /^\{\{\s*(.+?)\s*\}\}$/.exec(conv.value.trim());
    if (whole) {
      path = whole[1];
    } else if (conv.value.includes("{{")) {
      notes.push(
        `condition left side '${left}' is not a plain path — set it by hand.`,
      );
    } else {
      // A literal left side (n8n allows it) is not addressable as a path here.
      notes.push(
        `condition compares the literal '${conv.value}' rather than a field — set the path by hand.`,
      );
    }
  }
  // `true`/`false` operators in n8n's boolean filter carry no rightValue.
  const value =
    rawOp === "true" ? true : rawOp === "false" ? false : (right ?? undefined);

  const out: EdgeCondition = { path, op: op ?? "exists" };
  if (
    value !== undefined &&
    op !== "exists" &&
    op !== "isEmpty" &&
    op !== "notEmpty"
  ) {
    out.value = value;
  }
  return out;
}

/** Collect the conditions out of an n8n IF/Filter/Switch-rule parameter block (v1 and v2 shapes). */
function collectConditions(
  params: Record<string, unknown>,
  predecessorId: string | null,
  nameToId: ReadonlyMap<string, string>,
  notes: string[],
): { conditions: EdgeCondition[]; combine: "and" | "or" | undefined } {
  const block = asRecord(params.conditions);
  // v2: { conditions: { conditions: [...], combinator: "and" } }
  const v2 = Array.isArray(block.conditions)
    ? (block.conditions as unknown[])
    : null;
  if (v2) {
    const combinator = asString(block.combinator);
    return {
      conditions: v2.map((c) => toCondition(c, predecessorId, nameToId, notes)),
      combine: combinator === "or" ? "or" : "and",
    };
  }
  // v1: { conditions: { string: [...], number: [...], boolean: [...] } }
  const v1: unknown[] = [];
  for (const key of ["string", "number", "boolean", "dateTime"]) {
    const arr = block[key];
    if (Array.isArray(arr)) v1.push(...arr);
  }
  if (v1.length > 0) {
    return {
      conditions: v1.map((c) => toCondition(c, predecessorId, nameToId, notes)),
      combine: asString(params.combineOperation) === "any" ? "or" : "and",
    };
  }
  notes.push(
    "no conditions found in the n8n node — the branch will need its condition set by hand.",
  );
  return { conditions: [], combine: undefined };
}

/** n8n Set node → our `set.fields`. Handles the v3 `assignments` shape and the v2 `values` shape. */
function setFields(
  params: Record<string, unknown>,
  predecessorId: string | null,
  nameToId: ReadonlyMap<string, string>,
  sink: UnconvertedExpression[],
  nodeId: string,
): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  const push = (name: unknown, value: unknown, where: string): void => {
    const key = asString(name);
    if (!key) return;
    const conv = convertN8nValueDeep(value, predecessorId, nameToId, where);
    for (const u of conv.unconverted) {
      sink.push({
        nodeId,
        field: u.field,
        expression: u.expression,
        reason: u.reason,
      });
    }
    fields[key] = conv.value;
  };

  // v3.4: { assignments: { assignments: [{ name, value, type }] } }
  const assignments = asRecord(params.assignments).assignments;
  if (Array.isArray(assignments)) {
    for (const a of assignments) {
      const rec = asRecord(a);
      push(rec.name, rec.value, `assignments.${asString(rec.name) ?? "?"}`);
    }
    return fields;
  }
  // v2: { values: { string: [{name, value}], number: [...], boolean: [...] } }
  const values = asRecord(params.values);
  for (const group of Object.values(values)) {
    if (!Array.isArray(group)) continue;
    for (const v of group) {
      const rec = asRecord(v);
      push(rec.name, rec.value, `values.${asString(rec.name) ?? "?"}`);
    }
  }
  return fields;
}

/** n8n schedule/cron parameters → a cron expression. Returns null when it can't be derived. */
function toCron(params: Record<string, unknown>): string | null {
  // v1.2 Schedule Trigger: { rule: { interval: [{ field: "hours", hoursInterval: 2 }] } }
  const interval = asRecord(params.rule).interval;
  const first = Array.isArray(interval) ? asRecord(interval[0]) : {};
  const field = asString(first.field);
  if (field === "minutes") {
    const n = asNumber(first.minutesInterval) ?? 5;
    return `*/${n} * * * *`;
  }
  if (field === "hours") {
    const n = asNumber(first.hoursInterval) ?? 1;
    return `0 */${n} * * *`;
  }
  if (field === "days") {
    const h = asNumber(first.triggerAtHour) ?? 0;
    const m = asNumber(first.triggerAtMinute) ?? 0;
    return `${m} ${h} * * *`;
  }
  if (field === "weeks") {
    const h = asNumber(first.triggerAtHour) ?? 0;
    const m = asNumber(first.triggerAtMinute) ?? 0;
    const d = asNumber(first.triggerAtDay) ?? 1;
    return `${m} ${h} * * ${d}`;
  }
  if (field === "cronExpression") {
    return asString(first.expression) ?? null;
  }
  // Legacy Cron node: { triggerTimes: { item: [{ mode: "custom", cronExpression }] } }
  const item = asRecord(params.triggerTimes).item;
  const t = Array.isArray(item) ? asRecord(item[0]) : {};
  return asString(t.cronExpression) ?? asString(params.cronExpression) ?? null;
}

// ── per-node-type config translation ──────────────────────────────────────────────────────────

export interface TranslateCtx {
  nodeId: string;
  params: Record<string, unknown>;
  predecessorId: string | null;
  nameToId: ReadonlyMap<string, string>;
  notes: string[];
  exprSink: UnconvertedExpression[];
}

/** Convert one n8n parameter through the expression translator, recording unconverted tokens. */
function expr(ctx: TranslateCtx, key: string, fallback = ""): string {
  const raw = ctx.params[key];
  if (typeof raw !== "string") return fallback;
  const conv = convertN8nExpression(raw, ctx.predecessorId, ctx.nameToId);
  for (const u of conv.unconverted) {
    ctx.exprSink.push({
      nodeId: ctx.nodeId,
      field: key,
      expression: u.expression,
      reason: u.reason,
    });
  }
  return conv.value;
}

/** n8n's `{ parameters: { headerParameters: { parameters: [{name, value}] } } }` → a flat record. */
function nameValuePairs(
  ctx: TranslateCtx,
  block: unknown,
): Record<string, string> {
  const out: Record<string, string> = {};
  const arr = asRecord(block).parameters;
  if (!Array.isArray(arr)) return out;
  for (const p of arr) {
    const rec = asRecord(p);
    const key = asString(rec.name);
    if (!key) continue;
    const conv = convertN8nExpression(
      typeof rec.value === "string" ? rec.value : String(rec.value ?? ""),
      ctx.predecessorId,
      ctx.nameToId,
    );
    for (const u of conv.unconverted) {
      ctx.exprSink.push({
        nodeId: ctx.nodeId,
        field: key,
        expression: u.expression,
        reason: u.reason,
      });
    }
    out[key] = conv.value;
  }
  return out;
}

/**
 * Translate an n8n node's parameters into our config for `nodeType`.
 *
 * Every branch is deliberately conservative: it fills what maps cleanly and leaves the rest for the
 * user, pushing a note. The save gate is lenient on missing fields, so an incomplete config is a
 * saveable draft — which is exactly the right failure mode for an importer.
 */
export function translateConfig(
  nodeType: NodeType,
  ctx: TranslateCtx,
): Record<string, unknown> {
  const { params } = ctx;
  switch (nodeType) {
    case "httpRequest": {
      const method = String(asString(params.method) ?? "GET").toUpperCase();
      const allowed = ["GET", "POST", "PUT", "PATCH", "DELETE"];
      if (!allowed.includes(method)) {
        ctx.notes.push(
          `HTTP method '${method}' is not supported — imported as GET.`,
        );
      }
      const cfg: Record<string, unknown> = {
        method: allowed.includes(method) ? method : "GET",
        url: expr(ctx, "url"),
      };
      const headers = nameValuePairs(ctx, params.headerParameters);
      if (Object.keys(headers).length) cfg.headers = headers;
      const query = nameValuePairs(ctx, params.queryParameters);
      if (Object.keys(query).length) cfg.query = query;
      const bodyPairs = nameValuePairs(ctx, params.bodyParameters);
      if (Object.keys(bodyPairs).length) {
        cfg.body = bodyPairs;
      } else if (params.jsonBody !== undefined) {
        const conv = convertN8nValueDeep(
          params.jsonBody,
          ctx.predecessorId,
          ctx.nameToId,
          "jsonBody",
        );
        for (const u of conv.unconverted) {
          ctx.exprSink.push({ nodeId: ctx.nodeId, ...u });
        }
        cfg.body = conv.value;
      }
      return cfg;
    }
    case "graphQL":
      return { url: expr(ctx, "endpoint"), query: expr(ctx, "query") };
    case "rssRead":
      return { url: expr(ctx, "url") };
    case "sqlQuery":
    case "sqlExec": {
      const sql = expr(ctx, "query");
      if (!sql) {
        ctx.notes.push(
          "the original did not use a raw SQL query (n8n's table/column UI) — write the SQL by hand.",
        );
      }
      // connectionId is intentionally absent: a database connection must be created here first.
      return sql ? { sql } : {};
    }
    case "scheduleTrigger": {
      const cron = toCron(params);
      if (!cron) {
        ctx.notes.push(
          "could not derive a cron expression from the n8n schedule — set it by hand.",
        );
        return {};
      }
      return { cron };
    }
    case "pollTrigger": {
      const url = expr(ctx, "url");
      return url ? { url, intervalSeconds: 300 } : { intervalSeconds: 300 };
    }
    case "set":
      return {
        fields: setFields(
          params,
          ctx.predecessorId,
          ctx.nameToId,
          ctx.exprSink,
          ctx.nodeId,
        ),
      };
    case "code": {
      const code =
        asString(params.jsCode) ??
        asString(params.functionCode) ??
        asString(params.code);
      if (!code) {
        ctx.notes.push("no JavaScript body found on the n8n node.");
        return {};
      }
      if (/\$input|\bitems\b|\$json/.test(code)) {
        ctx.notes.push(
          "the code body references n8n's item API — our code node receives ($input, $ctx); review it before running.",
        );
      }
      return { code };
    }
    case "if": {
      const { conditions, combine } = collectConditions(
        params,
        ctx.predecessorId,
        ctx.nameToId,
        ctx.notes,
      );
      return combine ? { conditions, combine } : { conditions };
    }
    case "switch": {
      const rulesBlock = asRecord(params.rules).values ?? params.rules;
      const rules: Array<{ name: string; condition: EdgeCondition }> = [];
      if (Array.isArray(rulesBlock)) {
        rulesBlock.forEach((r, i) => {
          const rec = asRecord(r);
          const name =
            asString(rec.outputKey) ??
            asString(rec.renameOutput) ??
            `rule-${i + 1}`;
          const { conditions } = collectConditions(
            rec as Record<string, unknown>,
            ctx.predecessorId,
            ctx.nameToId,
            ctx.notes,
          );
          rules.push({
            name,
            condition: conditions[0] ?? { path: "", op: "exists" },
          });
          if (conditions.length > 1) {
            ctx.notes.push(
              `switch rule '${name}' had ${conditions.length} conditions; our switch takes one per rule — only the first was kept.`,
            );
          }
        });
      }
      if (rules.length === 0) {
        ctx.notes.push("no switch rules found — add them by hand.");
      }
      // n8n's `options.fallbackOutput` adds an EXTRA output taken when no rule matched. Our switch
      // expresses the same thing as a `fallback` name that lands in `matched` — which matters a lot:
      // without it, the edge off that extra output would be UNCONDITIONAL and the fallback branch
      // would fire on every run, no matter which rule actually matched.
      const fallbackOutput = asRecord(params.options).fallbackOutput;
      if (fallbackOutput === "extra") {
        const taken = new Set(rules.map((r) => r.name));
        let name = FALLBACK_RULE_NAME;
        let n = 2;
        while (taken.has(name)) {
          name = `${FALLBACK_RULE_NAME}-${n}`;
          n += 1;
        }
        return { rules, fallback: name };
      }
      if (typeof fallbackOutput === "number" && rules[fallbackOutput]) {
        // n8n can also route the fallback into an EXISTING output. Our switch has one fallback name,
        // so point it at that rule's name: an unmatched item then takes the same branch.
        return { rules, fallback: rules[fallbackOutput].name };
      }
      return { rules };
    }
    case "filter": {
      const { conditions } = collectConditions(
        params,
        ctx.predecessorId,
        ctx.nameToId,
        ctx.notes,
      );
      const cfg: Record<string, unknown> = {
        from: ctx.predecessorId ?? "__input",
      };
      if (conditions[0]) cfg.condition = conditions[0];
      else ctx.notes.push("no filter condition found — set it by hand.");
      return cfg;
    }
    case "aggregate":
      return {
        from: ctx.predecessorId ?? "__input",
        operation: "collect",
      };
    case "listOps":
    case "markdown":
    case "xml":
    case "csv":
    case "json":
    case "htmlExtract":
      // These need a `from` (which upstream output to read) that n8n expresses implicitly as "the
      // incoming item"; the operation comes from the mapping's baseConfig.
      return { from: ctx.predecessorId ?? "__input" };
    case "renameKeys": {
      const cfg: Record<string, unknown> = {
        from: ctx.predecessorId ?? "__input",
      };
      const rename: Record<string, string> = {};
      const keys = asRecord(params.keys).key;
      if (Array.isArray(keys)) {
        for (const k of keys) {
          const rec = asRecord(k);
          const from = asString(rec.currentKey);
          const to = asString(rec.newKey);
          if (from && to) rename[from] = to;
        }
      }
      if (Object.keys(rename).length) cfg.rename = rename;
      return cfg;
    }
    case "compareDatasets":
      return {
        a: { from: ctx.predecessorId ?? "__input" },
        b: { from: ctx.predecessorId ?? "__input" },
        key: "id",
      };
    case "dateTime":
      return { source: "now" };
    case "hash":
      return { algorithm: "sha256" };
    case "wait": {
      const amount = asNumber(params.amount);
      const unit = asString(params.unit) ?? "seconds";
      if (asString(params.resume) === "webhook") {
        return { mode: "webhook" };
      }
      const mult =
        unit === "minutes"
          ? 60
          : unit === "hours"
            ? 3600
            : unit === "days"
              ? 86400
              : 1;
      return amount === undefined
        ? { mode: "duration" }
        : { mode: "duration", durationSeconds: amount * mult };
    }
    case "respondToWebhook": {
      const cfg: Record<string, unknown> = {};
      const code = asNumber(asRecord(params.options).responseCode);
      if (code !== undefined) cfg.statusCode = code;
      // n8n's `respondWith` picks the shape (json / text / firstIncomingItem / noData). Only an
      // explicit body is translatable; `firstIncomingItem` is already our default (an omitted body
      // responds with the run context), so it needs no config.
      const respondWith = asString(params.respondWith);
      const body = expr(ctx, "responseBody");
      if (body) {
        cfg.body = body;
      } else if (respondWith && respondWith !== "firstIncomingItem") {
        ctx.notes.push(
          `n8n responded with '${respondWith}' and no explicit body — check what this node should return.`,
        );
      }
      return cfg;
    }
    case "stopAndError": {
      const message = expr(ctx, "errorMessage");
      return message ? { message } : {};
    }
    case "sendEmail": {
      // connectionId deliberately absent — an SMTP connection must be created here.
      const cfg: Record<string, unknown> = {};
      const to = expr(ctx, "toEmail") || expr(ctx, "sendTo");
      if (to) cfg.to = to;
      const from = expr(ctx, "fromEmail");
      if (from) cfg.from = from;
      const subject = expr(ctx, "subject");
      if (subject) cfg.subject = subject;
      const text = expr(ctx, "text") || expr(ctx, "message");
      if (text) cfg.text = text;
      const html = expr(ctx, "html");
      if (html) cfg.html = html;
      return cfg;
    }
    case "agent": {
      const cfg: Record<string, unknown> = {};
      // n8n splits the instruction between `options.systemMessage` (the persona) and `text`/`prompt`
      // (the per-run message). We have one `systemPrompt`, so prefer the system message and append
      // the prompt — and say so, since concatenating them is a reshape, not a faithful import.
      const systemMessage = asString(asRecord(params.options).systemMessage);
      const prompt = expr(ctx, "text") || expr(ctx, "prompt");
      const parts = [systemMessage, prompt].filter(Boolean);
      if (parts.length === 2) {
        ctx.notes.push(
          "n8n's system message and prompt were joined into our single systemPrompt — review the wording.",
        );
      }
      if (parts.length > 0) cfg.systemPrompt = parts.join("\n\n");
      else {
        ctx.notes.push(
          "no prompt found on the n8n agent node — write the system prompt by hand.",
        );
      }
      // Provider/model come from the attached LLM sub-node, folded in after the nodes are built.
      return cfg;
    }
    case "merge": {
      const mode = asString(params.mode);
      return mode === "combine" ? { mode: "object" } : { mode: "array" };
    }
    case "formTrigger": {
      const cfg: Record<string, unknown> = {};
      const title = asString(params.formTitle);
      if (title) cfg.title = title;
      const desc = asString(params.formDescription);
      if (desc) cfg.description = desc;
      const raw = asRecord(params.formFields).values;
      const fields: Array<Record<string, unknown>> = [];
      if (Array.isArray(raw)) {
        for (const f of raw) {
          const rec = asRecord(f);
          const label = asString(rec.fieldLabel);
          if (!label) continue;
          const n8nType = asString(rec.fieldType) ?? "text";
          const type =
            n8nType === "number"
              ? "number"
              : n8nType === "email"
                ? "email"
                : n8nType === "textarea"
                  ? "textarea"
                  : n8nType === "dropdown" || n8nType === "select"
                    ? "select"
                    : "text";
          if (type === "text" && n8nType !== "text") {
            ctx.notes.push(
              `form field type '${n8nType}' has no equivalent — imported as text.`,
            );
          }
          const field: Record<string, unknown> = {
            key:
              label
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, "_")
                .replace(/^_+|_+$/g, "") || "field",
            label,
            type,
          };
          if (rec.requiredField === true) field.required = true;
          fields.push(field);
        }
      }
      cfg.fields = fields;
      if (fields.length === 0) {
        ctx.notes.push("no form fields found — add them by hand.");
      }
      return cfg;
    }
    default:
      // webhookTrigger / errorTrigger / start / noOp / end take no translated config.
      return {};
  }
}
