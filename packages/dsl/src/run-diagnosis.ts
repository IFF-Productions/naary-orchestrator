/**
 * Turn a FAILED run into an instruction an AI edit can act on: "this is what broke, and here is
 * what the failing node was actually working with — fix the workflow."
 *
 * WHY THIS IS SHARED, AND PURE. It runs in two places: the canvas, when a user presses "Fix with
 * AI" on a failed run, and the worker, when self-healing proposes a fix on its own. Two copies
 * would drift, and what they would drift on is the privacy rule below — the worst possible thing
 * to have two opinions about. Pure and total (no I/O, no clock, no randomness) so it is safe to
 * call from workflow-adjacent code as well as the browser.
 *
 * WHAT LEAVES THE TENANT. This text is sent to a model, so the contents are a deliberate choice:
 *
 *   INCLUDED  the error and failure kind; the failing node's id/type/config, BOTH as authored and
 *             as it actually ran (templates filled in); the redacted HTTP capture (already
 *             header-allowlisted, secret-scrubbed and truncated AT THE SOURCE by the worker,
 *             #916); the run's trigger input; and the output of EVERY step that ran.
 *   EXCLUDED  `$secrets` values, `$vars` values, and `__*` run bookkeeping other than `__input`.
 *
 * "Every step that ran" is a widening, taken deliberately: the earlier version sent only the steps
 * the failing node reads, and a cause two steps further upstream was simply unreachable — the
 * model could see a bad value arrive but never where it came from. The cost is that a step
 * unrelated to the failure may hold data the failure has nothing to do with, and it is sent too.
 * That trade was put plainly and taken; the section is ordered so the steps the failing node reads
 * come first, and bounded so a large run cannot produce an unbounded prompt.
 *
 * The exclusions are enforced HERE and asserted by tests, not left to each caller to remember.
 * `$vars`/`$secrets` matter especially: they are reachable through the very same reference walk
 * (`{{ $vars.KEY }}` has head `$vars`), so they have to be dropped by name — being "not a node" is
 * not enough to keep them out on its own. In the RESOLVED config they stay as literal tokens
 * rather than resolving to blanks, so "not disclosed" never reads as "was empty".
 *
 * One assumption worth stating: the failing node's config is sent verbatim, because a fix cannot
 * be proposed without it. That is safe insofar as credentials live in connections (by id) and in
 * `$secrets` (by reference) rather than as literals in a config — which is what those mechanisms
 * exist for. A user who has pasted a raw key into a config field is exposing it here.
 *
 * BOTH CALLERS SHARE THIS. The canvas's "Fix with AI" and the worker's automatic self-healing send
 * the same text — one function, one boundary, one set of tests. Two disclosure rules would drift,
 * and what they would drift on is what leaves the tenant.
 */
import { isReservedCtxKey, referencedNodeIds } from "./rename-node";
import { resolveTemplates } from "./template";
import type { GraphDef, NodeDef } from "./types";

/**
 * The failing node's captured request/response, structurally. Restated rather than imported so
 * `@naary/dsl` keeps no dependency on the API or worker — the same reasoning the API's own
 * `HttpFailureView` gives for restating the worker's `HttpFailureCapture`.
 */
export interface DiagnosisHttpCapture {
  request?: {
    method?: string;
    url?: string;
    headers?: Record<string, string>;
    body?: { text?: string; truncated?: boolean };
    bodyWithheld?: string;
  };
  response?: {
    status?: number;
    statusText?: string;
    headers?: Record<string, string>;
    body?: { text?: string; truncated?: boolean };
  };
}

export interface FixInstructionInput {
  /** The graph to be fixed — the workflow's CURRENT version, not the run's pinned snapshot. */
  graph: GraphDef;
  /** The node the run died on (`failedNodeId` from the read model, #525). */
  failedNodeId: string;
  error?: string | null;
  /** Classified failure (`failureKind`), when the read model has one. */
  failureKind?: string | null;
  http?: DiagnosisHttpCapture | null;
  /** The run ctx. Only the entries named by `referencedNodeIds` are ever read out of it. */
  ctx?: Record<string, unknown>;
  /**
   * Whether the run's step outputs could be READ at all — distinct from the run having produced
   * none. A closed run whose ctx we failed to recover answers `{}`, which is indistinguishable
   * from an empty run unless the caller says so. Pass `false` there, and the instruction admits
   * the gap instead of telling the model the node reads nothing. Defaults to true.
   */
  ctxAvailable?: boolean;
}

export interface FixInstruction {
  /** The change description. The generator wraps this with its own edit + preservation rules. */
  instruction: string;
  /** Whose outputs were included — so the UI can state exactly what is being sent. */
  includedNodeIds: string[];
}

/** Per-node cap on an included output. Big enough to diagnose, small enough not to be the prompt. */
const MAX_OUTPUT_CHARS = 2_000;
/**
 * Cap on the step-outputs SECTION as a whole. Per-step clipping alone bounds nothing once every
 * step is included — a 200-step run would still produce a vast prompt, in tokens and in cost. When
 * this is spent the section stops and says how many steps it dropped; the ordering below makes
 * the steps the failing node reads the ones that survive.
 */
const MAX_OUTPUTS_CHARS = 12_000;
/** Cap on a captured request/response body, which the worker has already truncated once. */
const MAX_BODY_CHARS = 1_000;

/**
 * References this diagnosis declines to resolve when showing the config "as it ran".
 *
 * `$secrets` is handled unconditionally by the resolver itself. This adds the two things we send
 * nothing about: `$vars` (workspace configuration, not run data) and `__*` bookkeeping — except
 * `__input`, which IS the run's input and is disclosed in full below, so resolving it discloses
 * nothing new.
 *
 * Kept LITERAL rather than resolved-to-blank on purpose: an empty value would read as "this field
 * was empty when it ran", which is a different and false claim.
 */
function keepLiteralInDiagnosis(ref: string): boolean {
  const head = ref.split(".")[0]?.trim() ?? "";
  return head === "$vars" || (head.startsWith("__") && head !== "__input");
}

/**
 * Serialize the RESOLVED config, showing references that resolved to nothing.
 *
 * `JSON.stringify` drops keys whose value is `undefined`, and a whole-string token that resolved
 * to nothing is exactly that. So `"title": "{{ lookup.body.titel }}"` — a typo'd path, the single
 * commonest cause of the failures this feature diagnoses — rendered as no `title` key at all. The
 * one bug the AS-IT-RAN block exists to expose was the one it hid, and a missing key reads as "this
 * node has no title field", which is a different and false claim.
 *
 * A marker instead. It sits directly under the authored config, so `"title": "<unresolved>"` beside
 * `"title": "{{ lookup.body.titel }}"` names the culprit without this function having to re-parse
 * anything — no second copy of the template grammar to drift from the resolver's.
 */
function clipResolved(value: unknown, max: number): string {
  let text: string;
  try {
    text =
      JSON.stringify(value, (_k, v) =>
        v === undefined ? "<unresolved>" : v,
      ) ?? String(value);
  } catch {
    return "[unserializable]";
  }
  return text.length <= max
    ? text
    : `${text.slice(0, max)}… [truncated, ${text.length} chars total]`;
}

/** JSON, length-capped, with the truncation stated rather than silent. */
function clip(value: unknown, max: number): string {
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    // Circular or unserializable — the shape is not worth failing a diagnosis over.
    return "[unserializable]";
  }
  return text.length <= max
    ? text
    : `${text.slice(0, max)}… [truncated, ${text.length} chars total]`;
}

function describeHttp(http: DiagnosisHttpCapture): string {
  const lines: string[] = [];
  const req = http.request;
  if (req) {
    lines.push(`  request: ${req.method ?? "GET"} ${req.url ?? "(no url)"}`);
    const headers = Object.keys(req.headers ?? {});
    if (headers.length) lines.push(`  request headers: ${headers.join(", ")}`);
    if (req.bodyWithheld) lines.push(`  request body: ${req.bodyWithheld}`);
    else if (req.body?.text)
      lines.push(`  request body: ${clip(req.body.text, MAX_BODY_CHARS)}`);
  }
  const res = http.response;
  if (res) {
    lines.push(
      `  response: ${res.status ?? "?"}${res.statusText ? ` ${res.statusText}` : ""}`,
    );
    if (res.body?.text)
      lines.push(`  response body: ${clip(res.body.text, MAX_BODY_CHARS)}`);
  }
  return lines.join("\n");
}

/**
 * Build the change description for a failed run. Never throws: a diagnosis missing a detail is
 * worth more than an exception on the one screen someone reached because something already broke.
 */
export function buildFixInstruction(
  input: FixInstructionInput,
): FixInstruction {
  const { graph, failedNodeId, error, failureKind, http, ctx, ctxAvailable } =
    input;
  const node: NodeDef | undefined = graph?.nodes?.find(
    (n) => n.id === failedNodeId,
  );

  const parts: string[] = [];
  parts.push(
    `A run of this workflow FAILED. Change the workflow so this failure does not happen again.`,
  );
  parts.push(
    `\nFailed at node: "${failedNodeId}"${node ? ` (type: ${node.type})` : " (no longer in the workflow)"}`,
  );
  if (failureKind) parts.push(`Failure kind: ${failureKind}`);
  parts.push(`Error: ${error?.trim() || "(no error message was recorded)"}`);

  if (node) {
    parts.push(
      `\nThat node's current configuration:\n${clip(node.config ?? {}, MAX_OUTPUT_CHARS)}`,
    );
    // The same config with `{{ … }}` filled in from this run's data. The authored version above is
    // what a fix has to EDIT; this is what actually went out, and it is where a whole class of bug
    // becomes visible — a mistyped path (`{{ lookup.body.titel }}`) resolves to nothing, so the
    // call was made without that field. Invisible in the template, obvious here.
    //
    // ONLY WHEN THE CTX WAS ACTUALLY READ. Resolving against a ctx we failed to recover marks
    // every reference `<unresolved>` — which asserts "this produced no value at runtime" when the
    // truth is "we don't know what it produced". That is the exact confident-falsehood this file
    // grew `ctxAvailable` to prevent, and building this block reintroduced it one level down.
    const ranAs =
      ctxAvailable === false
        ? undefined
        : resolveTemplates(
            (node.config ?? {}) as Record<string, unknown>,
            ctx ?? {},
            keepLiteralInDiagnosis,
          );
    // Only when it differs — a config with no templates would just repeat itself, and a second
    // identical block invites the model to treat it as a second, different fact.
    const ranAsText =
      ranAs === undefined ? null : clipResolved(ranAs, MAX_OUTPUT_CHARS);
    if (
      ranAsText !== null &&
      ranAsText !== clip(node.config ?? {}, MAX_OUTPUT_CHARS)
    ) {
      parts.push(
        `\nThe same configuration AS IT RAN, with this run's values filled in ` +
          `(\`{{ $secrets… }}\` and \`{{ $vars… }}\` are deliberately left unresolved; ` +
          `\`<unresolved>\` marks a reference that produced no value):\n${ranAsText}`,
      );
    }
  }

  // The run's own input. Half of "the failed run's inputs and outputs", and previously swept up in
  // the "`__*` is bookkeeping" exclusion — right for `__nodeTimes`/`__costUsd`, wrong for this.
  if (ctx?.__input !== undefined) {
    parts.push(
      `\nThe input that started this run:\n  ${clip(ctx.__input, MAX_OUTPUT_CHARS)}`,
    );
  }

  if (http) {
    const described = describeHttp(http);
    if (described) {
      parts.push(
        `\nThe call that node made (secrets already redacted at capture):\n${described}`,
      );
    }
  }

  // EVERY step that ran, ordered so the ones this node reads come first.
  //
  // `referencedNodeIds` used to FILTER this list; now it only SORTS it. The filter meant a cause
  // two steps upstream was unreachable — the model could see a bad value arrive and never see
  // where it came from. Ordering still matters because the section is bounded: when the budget
  // runs out, the steps the failing node reads are the ones that must survive.
  //
  // Reserved ctx keys are dropped by name: `$vars`/`$secrets` values are not disclosed, and `__*`
  // is bookkeeping (`__input` is rendered above, as the run's input, rather than as a "step").
  const reads = node ? referencedNodeIds(node) : [];
  const ran = ctx ? Object.keys(ctx).filter((k) => !isReservedCtxKey(k)) : [];
  const ordered = [
    ...reads.filter((id) => ran.includes(id)),
    ...ran.filter((id) => !reads.includes(id)),
  ];

  const includedNodeIds: string[] = [];
  const rows: string[] = [];
  let spent = 0;
  for (const id of ordered) {
    const row = `  ${id}: ${clip(ctx?.[id], MAX_OUTPUT_CHARS)}`;
    // Always take the first row even if it alone exceeds the budget — a diagnosis with no step
    // data at all is worse than one slightly over, and `clip` has already bounded that row.
    if (rows.length > 0 && spent + row.length > MAX_OUTPUTS_CHARS) continue;
    rows.push(row);
    includedNodeIds.push(id);
    spent += row.length;
  }
  const omitted = ordered.length - includedNodeIds.length;

  if (rows.length) {
    parts.push(
      `\nEvery step that ran in this run, the ones this node reads from first:\n${rows.join("\n")}` +
        // Never silently truncate a disclosure — the same reason `clip` announces its own.
        (omitted > 0
          ? `\n  … and ${omitted} more step${omitted === 1 ? "" : "s"} omitted for length.`
          : ""),
    );
  } else if (node) {
    // Nothing to show. Three different reasons, and collapsing them would state a fact about the
    // workflow that is really a fact about our fetch. `ctxAvailable: false` is the one that
    // matters: a closed run whose ctx we could not read answers `{}`, and calling that "no step
    // produced output" would send the model a confident falsehood — the same shape of bug as a
    // swallowed catch.
    parts.push(
      `\n${
        ctxAvailable === false
          ? "The step outputs for this run could not be read, so what that node received is unknown. Diagnose from the error and configuration alone."
          : reads.length === 0
            ? "No step in this run produced any output, and that node reads no data from other steps."
            : `That node reads from ${reads.map((r) => `"${r}"`).join(", ")}, and those steps produced no output in this run.`
      }`,
    );
  }

  parts.push(
    `\nDiagnose the cause from the above and change ONLY what is needed to fix it. If the cause ` +
      `is a bad value or a missing field, correct that node's configuration; if it is an ` +
      `unhandled case, add the handling. Do not restructure anything unrelated to this failure.`,
  );

  return { instruction: parts.join("\n"), includedNodeIds };
}
