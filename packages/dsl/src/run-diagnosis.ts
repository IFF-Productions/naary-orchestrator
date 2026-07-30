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
 * WHAT LEAVES THE TENANT. This text is sent to a model, so the contents are a deliberate,
 * minimal choice rather than "everything we happen to have":
 *
 *   INCLUDED  the error and failure kind; the failing node's id/type/config; the redacted HTTP
 *             capture (already header-allowlisted, secret-scrubbed and truncated AT THE SOURCE by
 *             the worker, #916); and the outputs of the nodes the failing node ACTUALLY READ —
 *             `referencedNodeIds`, not "everything upstream".
 *   EXCLUDED  every other node's output, `$vars`, `$secrets`, and all `__*` run bookkeeping.
 *
 * The exclusions are enforced HERE and asserted by tests, not left to each caller to remember.
 * `$vars`/`$secrets` matter especially: they are reachable through the very same reference walk
 * (`{{ $vars.KEY }}` has head `$vars`), so they have to be dropped by name — being "not a node" is
 * not enough to keep them out on its own.
 *
 * One assumption worth stating: the failing node's config is sent verbatim, because a fix cannot
 * be proposed without it. That is safe insofar as credentials live in connections (by id) and in
 * `$secrets` (by reference) rather than as literals in a config — which is what those mechanisms
 * exist for. A user who has pasted a raw key into a config field is exposing it here.
 */
import { referencedNodeIds } from "./rename-node";
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
/** Cap on a captured request/response body, which the worker has already truncated once. */
const MAX_BODY_CHARS = 1_000;

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
  }

  if (http) {
    const described = describeHttp(http);
    if (described) {
      parts.push(
        `\nThe call that node made (secrets already redacted at capture):\n${described}`,
      );
    }
  }

  // The data the failing node actually read — the whole reason `referencedNodeIds` exists.
  // Reserved ctx keys ($vars/$secrets/__*) never appear: referencedNodeIds drops them at source,
  // since they are runtime-seeded keys rather than node ids.
  const reads = node ? referencedNodeIds(node) : [];
  const includedNodeIds = ctx ? reads.filter((id) => id in ctx) : [];

  if (includedNodeIds.length) {
    const rendered = includedNodeIds
      .map((id) => `  ${id}: ${clip(ctx?.[id], MAX_OUTPUT_CHARS)}`)
      .join("\n");
    parts.push(
      `\nWhat that node received from the steps it reads from:\n${rendered}`,
    );
  } else if (node) {
    // Three different situations, and collapsing them would state a fact about the workflow that
    // is really a fact about our fetch. `ctxAvailable: false` is the one that matters: a closed
    // run whose ctx we could not read answers `{}`, and calling that "reads no data" would send
    // the model a confident falsehood — the same shape of bug as a swallowed catch.
    parts.push(
      `\n${
        ctxAvailable === false
          ? "The step outputs for this run could not be read, so what that node received is unknown. Diagnose from the error and configuration alone."
          : reads.length === 0
            ? "That node reads no data from other steps."
            : `That node reads from ${reads.map((r) => `"${r}"`).join(", ")}, but those steps produced no output in this run.`
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
