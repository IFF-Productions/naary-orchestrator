import type { ArgBinding, EdgeCondition } from "./core";

/**
 * Set (Edit Fields) node — build a plain JSON object to pass downstream. Output is
 * exactly the built object (REPLACE-only: there is no implicit "input" to merge
 * with — bind explicitly from an upstream node id if you want a prior value).
 * Downstream nodes read fields via `<nodeId>.<field>`.
 *
 * PURE: this is deterministic graph work (no I/O, no secrets), resolved in the
 * interpreter like `resolveMcpArguments`/`resolveHttpRequest`. `fields` is the
 * static base; each `fieldBindings` entry fills/overrides the value at its dotted
 * path from an upstream output.
 */
export interface SetNodeConfig {
  /** Static base object (the values typed into the node). */
  fields?: Record<string, unknown>;
  /** dotted field path (e.g. "user.id", "total") → upstream output binding;
   *  overrides the static value at that path. */
  fieldBindings?: Record<string, ArgBinding>;
}

/** String operations for the Text node (n8n's string expression methods, as a node). */
export type TextOp =
  | "upper"
  | "lower"
  | "trim"
  | "replace"
  | "split"
  | "join"
  | "substring"
  | "length"
  | "regexExtract";

/**
 * Text node — one string operation on an upstream value. PURE (deterministic ctx read, no
 * I/O; regex uses `RegExp`, invalid patterns fail closed to null). Output is `{ result }`.
 * The input is coerced to a string for most ops; `join` expects an array. Covers the common
 * string transforms users otherwise reach for the Code node to do.
 */
export interface TextNodeConfig {
  operation: TextOp;
  /** Upstream node id whose output holds the input value. */
  from: string;
  /** Optional dotted path into that output. */
  path?: string;
  /** replace: the substring (or regex source when `useRegex`); regexExtract: the pattern. */
  search?: string;
  /** replace: the replacement text (supports $1 groups when `useRegex`). */
  replacement?: string;
  /** replace: treat `search` as a global regex. */
  useRegex?: boolean;
  /** split: the delimiter (default ","); join: the glue (default ","). */
  separator?: string;
  /** substring: start index (default 0). */
  start?: number;
  /** substring: end index (exclusive; omitted = to the end). */
  end?: number;
  /** regexExtract: capture group to return (default 0 = whole match). */
  group?: number;
}

/**
 * Rename Keys node — reshape an upstream object by renaming and/or dropping its
 * top-level keys. PURE (deterministic ctx read, no I/O). Output is the reshaped
 * object; downstream reads `<nodeId>.<newKey>`.
 */
export interface RenameKeysNodeConfig {
  /** Upstream node id whose output object to reshape. */
  from: string;
  /** Optional dotted path into that output to pick the object to reshape. */
  path?: string;
  /** oldKey → newKey. Keys not listed are kept as-is (unless dropped). */
  rename?: Record<string, string>;
  /** Top-level keys to remove from the output. */
  drop?: string[];
}

/**
 * Filter node — keep the items of an upstream ARRAY that match a per-item predicate.
 * PURE (deterministic ctx read, no I/O). The predicate is the same structured
 * `EdgeCondition` used on edges, evaluated against each item (so `condition.path` is
 * relative to the item). Output is the filtered array; a non-array source yields `[]`.
 */
export interface FilterNodeConfig {
  /** Upstream node id whose output holds the array. */
  from: string;
  /** Optional dotted path into that output to reach the array. */
  path?: string;
  /** Per-item predicate (reuses the edge-condition op set). */
  condition: EdgeCondition;
}

/** Aggregate operations over an upstream array. */
export type AggregateOp =
  "collect" | "count" | "sum" | "min" | "max" | "avg" | "first" | "last";

/**
 * List Ops node — reshape an upstream ARRAY into another array. PURE. `sort` orders
 * by `field` (item-relative dotted path; whole item if omitted) ascending/descending
 * (numbers numerically, else by string); `limit` takes the first `count`; `dedupe`
 * removes duplicates by `field` value (or whole-item JSON when omitted), keeping
 * first occurrence. Output is the resulting array; non-array source → [].
 */
export interface ListOpsNodeConfig {
  from: string;
  path?: string;
  operation: "sort" | "limit" | "dedupe";
  /** Item-relative field for sort/dedupe. */
  field?: string;
  /** Sort direction (default "asc"). */
  order?: "asc" | "desc";
  /** Max items for limit. */
  count?: number;
}

/**
 * Compare Datasets node — diff two upstream ARRAYS by a key field. PURE. Output is
 * `{ added, removed, changed, same }`: rows only in B (added), only in A (removed),
 * in both but not deep-equal (changed — `{ key, a, b }`), and identical (same).
 */
export interface CompareDatasetsNodeConfig {
  /** Left array (the baseline). */
  a: ArgBinding;
  /** Right array (the comparison). */
  b: ArgBinding;
  /** Item field whose value identifies a row in both arrays. */
  key: string;
}

/**
 * XML node — convert between XML text and an object. `parse` turns an XML string
 * (from `from`/`path`) into an object; `build` serializes an upstream object to an
 * XML string. Runs in an ACTIVITY (reuses fast-xml-parser). Output: the object
 * (parse) or `{ xml }` (build).
 */
export interface XmlNodeConfig {
  operation: "parse" | "build";
  /** Upstream node id whose output holds the XML string (parse) or object (build). */
  from: string;
  /** Optional dotted path into that output. */
  path?: string;
}

/**
 * CSV node — convert between CSV text and an array of rows (n8n's Spreadsheet File, CSV).
 * `parse` turns CSV text (from `from`/`path`) into rows (objects keyed by the header row
 * when `header`, else arrays); `build` serializes an upstream array of objects to CSV text.
 * Output: the rows array (parse) or `{ csv }` (build). Runs in an ACTIVITY (parser out of
 * the deterministic bundle, like `xml`). No secrets, no egress.
 */
export interface CsvNodeConfig {
  operation: "parse" | "build";
  /** Upstream node id whose output holds the CSV string (parse) or rows array (build). */
  from: string;
  /** Optional dotted path into that output. */
  path?: string;
  /** parse: treat the first row as the header (default true). build: emit a header row. */
  header?: boolean;
  /** Field delimiter (default ","). */
  delimiter?: string;
}

/** What the Random node generates. */
export type RandomOp = "uuid" | "hex" | "base64" | "alphanumeric" | "int";

/**
 * Random (Generate) node — produce a fresh random value (n8n's Crypto "Generate"): a UUID v4,
 * random hex/base64url of `length` bytes, an alphanumeric string of `length` chars, or a
 * uniform integer in `[min, max]`. Runs in an ACTIVITY because randomness is non-deterministic
 * (must not touch workflow code). No inputs — it generates. Output is `{ value }`.
 */
export interface RandomNodeConfig {
  operation: RandomOp;
  /** hex/base64: number of random bytes; alphanumeric: number of chars (default 16). */
  length?: number;
  /** int: inclusive lower bound (default 0). */
  min?: number;
  /** int: inclusive upper bound (default 100). */
  max?: number;
}

/** Encode/decode operations for the Encode node. */
export type EncodeOp =
  | "base64Encode"
  | "base64Decode"
  | "base64urlEncode"
  | "base64urlDecode"
  | "hexEncode"
  | "hexDecode"
  | "urlEncode"
  | "urlDecode";

/**
 * Encode node — convert a string to/from base64, base64url, hex, or URL-encoding (n8n's
 * base64Encode/urlEncode string methods). Output is `{ result }`. Runs in an ACTIVITY (uses
 * Node's Buffer, which isn't in the deterministic workflow bundle). No secrets, no egress.
 */
export interface EncodeNodeConfig {
  operation: EncodeOp;
  /** Upstream node id whose output holds the input string. */
  from: string;
  /** Optional dotted path into that output. */
  path?: string;
}

/** Arithmetic operations for the Number node. Binary use `a` and `b`; unary use `a`. */
export type MathOp =
  | "add"
  | "subtract"
  | "multiply"
  | "divide"
  | "modulo"
  | "power"
  | "round"
  | "floor"
  | "ceil"
  | "abs";

/**
 * Number (Math) node — one arithmetic operation. Operands come from a static value or an
 * upstream binding (coerced with Number()). Binary ops (add/subtract/multiply/divide/
 * modulo/power) use `a` and `b`; unary ops (round/floor/ceil/abs) use `a` (round honors
 * `precision`). PURE + deterministic → runs in the interpreter. Output is `{ result }`.
 */
export interface NumberNodeConfig {
  operation: MathOp;
  /** Left operand (static). */
  a?: number;
  /** Left operand from an upstream output (overrides `a`). */
  aBinding?: ArgBinding;
  /** Right operand (static; binary ops only). */
  b?: number;
  /** Right operand from an upstream output (overrides `b`). */
  bBinding?: ArgBinding;
  /** round: decimal places to keep (default 0). */
  precision?: number;
}

/**
 * JSON node — parse a JSON string into a value, or stringify a value into JSON text. PURE
 * (JSON.parse/stringify are deterministic ES built-ins — no I/O, no activity). `parse` output
 * IS the parsed value (object/array/…); `stringify` output is `{ json }`. Invalid JSON on
 * parse throws a node failure (so `onError: continue` can branch on it).
 */
export interface JsonNodeConfig {
  operation: "parse" | "stringify";
  /** Upstream node id whose output holds the JSON string (parse) or value (stringify). */
  from: string;
  /** Optional dotted path into that output. */
  path?: string;
  /** stringify: indent width for pretty-printing (0/omitted = compact). */
  indent?: number;
}

/** One field to pull out of an HTML document by CSS selector (HTML Extract node). */
export interface HtmlExtraction {
  /** Output key on the node's result object. */
  key: string;
  /** CSS selector (tag/class/id/attribute/descendant), e.g. "h1", ".price", "a.more". */
  selector: string;
  /** What to read from the matched element: its text (default), inner HTML, or an
   *  attribute's value. */
  return?: "text" | "html" | "attribute";
  /** Attribute name when `return` is "attribute" (e.g. "href"). */
  attribute?: string;
  /** Return every match as an array (default: just the first match's value). */
  all?: boolean;
}

/**
 * HTML Extract node — pull structured values out of an HTML string with CSS selectors
 * (n8n's HTML node, Extract operation). The HTML comes from an upstream node (`from`/`path`,
 * e.g. an `httpRequest` body); each extraction reads text / inner HTML / an attribute of
 * its selector's match(es). Output is `{ [key]: value }`.
 *
 * Runs in an ACTIVITY (like `xml`) to keep the HTML parser out of the deterministic
 * workflow bundle. No secrets, no egress (the fetch is a separate `httpRequest` node).
 */
export interface HtmlExtractNodeConfig {
  /** Upstream node id whose output holds the HTML string. */
  from: string;
  /** Optional dotted path into that output (e.g. "body"). */
  path?: string;
  /** The fields to extract. */
  extractions: HtmlExtraction[];
}

/** Markdown node — convert an upstream HTML string to Markdown. Output is `{ markdown }`. */
export interface MarkdownNodeConfig {
  /** Upstream node id whose output holds the HTML string. */
  from: string;
  /** Optional dotted path into that output (e.g. "body"). */
  path?: string;
}

/**
 * Aggregate node — collapse an upstream ARRAY into a single value. PURE. `collect`
 * → the array of `field` values (or whole items when `field` is omitted); `count` →
 * length; `sum` → numeric sum over `field`; `first`/`last` → an end item. Output is
 * `{ result }` so a graph can branch on `<nodeId>.result`.
 */
export interface AggregateNodeConfig {
  /** Upstream node id whose output holds the array. */
  from: string;
  /** Optional dotted path into that output to reach the array. */
  path?: string;
  operation: AggregateOp;
  /** Field to collect/sum from each item (dotted path, relative to the item). */
  field?: string;
}

/**
 * Date & Time node — output the current time, or do timestamp math on an upstream
 * value. The clock read is non-deterministic, so it runs in an ACTIVITY (CLAUDE.md
 * rule 2/3: time out of workflow code). Output is `{ iso, epochMs }`.
 */
export interface DateTimeNodeConfig {
  /** "now" (default) reads the clock in-activity; or bind an upstream epoch-ms
   *  number / ISO string to operate on instead. */
  source?: "now" | ArgBinding;
  /** Seconds to add to the base (may be negative). */
  addSeconds?: number;
}
