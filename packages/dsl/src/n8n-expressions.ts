/**
 * Best-effort translation of n8n expressions into our template-lite syntax (#579).
 *
 * The two languages are not comparable, and pretending otherwise is how an importer silently
 * corrupts a workflow. n8n expressions are **JavaScript**: `{{ $json.total * 1.2 }}`,
 * `{{ $items().map(i => i.json.id) }}`, `{{ $now.minus(1, 'day') }}` are all valid. Ours is a
 * deliberate non-language — `{{ nodeId.dotted.path }}` is a `getByPath` lookup, no eval, no
 * arithmetic (see template.ts) — precisely so it can run inside deterministic workflow code.
 *
 * So this module converts the subset that IS a path lookup, and **reports everything else as
 * unconverted** rather than guessing. An unconverted token is left in the config verbatim: the
 * user can see it, the mapping report names it, and `lintTemplates` will flag it in the editor.
 * (Until it's fixed it resolves to empty — which is why it must appear in the report.)
 *
 * Pure + dependency-free, like the rest of the DSL package.
 */

/** One n8n expression we could not translate, for the mapping report. */
export interface UnconvertedExpression {
  /** Our node id the expression landed on. */
  nodeId: string;
  /** Which config field it came from (the n8n parameter path). */
  field: string;
  /** The token as n8n wrote it, so the user can find and fix it. */
  expression: string;
  reason: string;
}

export interface ExpressionConversion {
  /** The converted string (unconverted tokens survive verbatim). */
  value: string;
  /** Empty when everything converted. */
  unconverted: { expression: string; reason: string }[];
  /** True when at least one token WAS converted — i.e. the value is a template, not a literal. */
  converted: boolean;
}

/** n8n marks an expression-valued parameter with a leading `=`. */
export function isN8nExpression(v: unknown): v is string {
  return typeof v === "string" && v.startsWith("=");
}

/** A dotted/bracketed path our `getByPath` can walk: `a.b[0].c`, `a[*].b`. No quotes, no calls. */
const SAFE_PATH = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\[\d+\]|\[\*\])*$/;

/** Roots n8n exposes that have no equivalent in a pure path lookup. */
const UNSUPPORTED_ROOTS: Record<string, string> = {
  $now: "n8n's $now is a DateTime object; use a dateTime node instead",
  $today: "n8n's $today is a DateTime object; use a dateTime node instead",
  $runIndex: "no equivalent — we have no per-run loop index in expressions",
  $itemIndex: "no equivalent — we have no per-item index in expressions",
  $execution: "no equivalent — run metadata is not exposed to expressions",
  $workflow: "no equivalent — workflow metadata is not exposed to expressions",
  $prevNode: "reference the upstream node by id instead",
  $parameter: "no equivalent — a node cannot read its own parameters",
  $credentials:
    "credentials are never available to an expression; use a connection, or $secrets.NAME",
  $env: "use $vars.NAME (Global Variables) or $secrets.NAME (Environment Secrets)",
  $input: "reference the upstream node by id instead",
  $items: "no equivalent — we have no $items() accessor",
  $evaluateExpression:
    "no equivalent — expressions are not evaluated recursively",
  $if: "no equivalent — use an if node and branch on edges",
  $jmespath: "no equivalent — use a code node",
  $binary: "no equivalent — binary data is not modelled in expressions",
};

/** Anything that makes a token JavaScript rather than a path. */
const JS_SIGNALS =
  /[+\-*/%!<>=?:|&,'"`]|\(|\)|=>|\bnew\b|\btypeof\b|\.\.\.|\?\?/;

const JS_REASON =
  "JavaScript expression — our expressions are path lookups only, so move the logic into a code node";

/** Why a tail like `total * 1.2` or `items.map(…)` isn't usable as a path. */
function notAPath(rest: string): string {
  return JS_SIGNALS.test(rest)
    ? JS_REASON
    : `'${rest}' is not a plain path (no quoted keys, calls, or operators)`;
}

/**
 * Translate ONE token's inner text (what sat between `{{` and `}}`).
 * Returns the replacement path, or a reason it can't be converted.
 */
function convertToken(
  inner: string,
  predecessorId: string | null,
  nameToId: ReadonlyMap<string, string>,
): { path: string } | { reason: string } {
  const src = inner.trim();

  // $node["Name"].json.x  /  $node['Name'].json.x
  let m = /^\$node\[\s*["']([^"']+)["']\s*\]\.json(?:\.(.+))?$/.exec(src);
  if (!m) {
    // $('Name').item.json.x  /  $("Name").first().json.x  /  $('Name').last().json.x
    m =
      /^\$\(\s*["']([^"']+)["']\s*\)(?:\.(?:item|first\(\)|last\(\)|all\(\)\[\d+\]))?\.json(?:\.(.+))?$/.exec(
        src,
      );
  }
  if (m) {
    const id = nameToId.get(m[1]);
    if (!id) {
      return {
        reason: `references n8n node "${m[1]}", which is not in this workflow`,
      };
    }
    const rest = m[2];
    if (rest === undefined) return { path: id };
    if (!SAFE_PATH.test(rest)) {
      return {
        reason: notAPath(rest),
      };
    }
    return { path: `${id}.${rest}` };
  }

  // $json / $json.a.b / $json["a"]
  m = /^\$json(?:\.(.+)|\[\s*["']([^"']+)["']\s*\])?$/.exec(src);
  if (m) {
    if (!predecessorId) {
      return {
        reason:
          "$json means 'the incoming item', but this node has no single upstream node to bind it to",
      };
    }
    const rest = m[1] ?? m[2];
    if (rest === undefined) return { path: predecessorId };
    if (!SAFE_PATH.test(rest)) {
      return {
        reason: notAPath(rest),
      };
    }
    return { path: `${predecessorId}.${rest}` };
  }

  // $vars.NAME — the one root that maps across unchanged.
  m = /^\$vars\.(.+)$/.exec(src);
  if (m) {
    if (!SAFE_PATH.test(m[1])) {
      return { reason: `'${m[1]}' is not a plain path` };
    }
    return { path: `$vars.${m[1]}` };
  }

  // Own-property lookup on an untrusted key. Safe here even without it (the regex forces a leading
  // `$`, which no prototype member has) — guarded anyway so the invariant doesn't depend on that
  // regex staying exactly as it is.
  const rootMatch = /^(\$[A-Za-z]\w*)/.exec(src);
  if (
    rootMatch &&
    Object.prototype.hasOwnProperty.call(UNSUPPORTED_ROOTS, rootMatch[1])
  ) {
    return { reason: UNSUPPORTED_ROOTS[rootMatch[1]] };
  }
  if (JS_SIGNALS.test(src)) return { reason: JS_REASON };
  return { reason: `unrecognised n8n expression '${src}'` };
}

/**
 * Convert an n8n parameter value. `raw` may be an expression (leading `=`) or a literal.
 *
 * The leading `=` is stripped; each `{{ … }}` token is translated independently, so a value that
 * mixes a convertible and an unconvertible token keeps the good half and reports the bad one.
 */
export function convertN8nExpression(
  raw: string,
  predecessorId: string | null,
  nameToId: ReadonlyMap<string, string>,
): ExpressionConversion {
  const unconverted: { expression: string; reason: string }[] = [];
  let converted = false;
  const body = raw.startsWith("=") ? raw.slice(1) : raw;

  const value = body.replace(/\{\{([\s\S]*?)\}\}/g, (whole, inner: string) => {
    const out = convertToken(inner, predecessorId, nameToId);
    if ("reason" in out) {
      unconverted.push({ expression: whole.trim(), reason: out.reason });
      return whole; // keep it verbatim — visible, reported, and never silently dropped
    }
    converted = true;
    return `{{ ${out.path} }}`;
  });

  return { value, unconverted, converted };
}

/**
 * Walk an arbitrary n8n parameter value (string / array / object) converting every expression it
 * contains, collecting unconverted tokens with the parameter path they came from.
 *
 * Cloned as it goes — the caller's input object is never mutated (the original is kept verbatim on
 * the placeholder/`__n8n` config, so it must stay pristine).
 */
export function convertN8nValueDeep(
  value: unknown,
  predecessorId: string | null,
  nameToId: ReadonlyMap<string, string>,
  path = "",
  sink: { field: string; expression: string; reason: string }[] = [],
): { value: unknown; unconverted: typeof sink } {
  if (typeof value === "string") {
    const c = convertN8nExpression(value, predecessorId, nameToId);
    for (const u of c.unconverted) {
      sink.push({ field: path, expression: u.expression, reason: u.reason });
    }
    return { value: c.value, unconverted: sink };
  }
  if (Array.isArray(value)) {
    const out = value.map(
      (v, i) =>
        convertN8nValueDeep(v, predecessorId, nameToId, `${path}[${i}]`, sink)
          .value,
    );
    return { value: out, unconverted: sink };
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // Prototype-pollution guard: an imported JSON blob is untrusted input, and these keys must
      // never reach an object we build (mirrors the bindingKey guard in registry.ts).
      if (k === "__proto__" || k === "constructor" || k === "prototype")
        continue;
      out[k] = convertN8nValueDeep(
        v,
        predecessorId,
        nameToId,
        path ? `${path}.${k}` : k,
        sink,
      ).value;
    }
    return { value: out, unconverted: sink };
  }
  return { value, unconverted: sink };
}
