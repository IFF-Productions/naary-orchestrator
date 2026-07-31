/**
 * Derive a `sampleInput` from a trigger node's OWN declaration (#983).
 *
 * A form declares its fields and a chat's payload is fixed, so for those two the shape a manual run
 * should carry is already written down — asking the author to retype it as JSON is asking them to
 * keep two copies of one contract in step. This derives the second copy from the first.
 *
 * DERIVES INTO THE EDITOR, NOT ON THE SERVER. The canvas offers this as a one-click fill that writes
 * the object into the node's config, where it is visible, versioned and editable; `startExecution`
 * still resolves plain `body.input → sampleInput → {}`. A server-side derive would be the same sin
 * #982 removed — a payload the service invents and the author cannot see (#979). Sample data belongs
 * to the sample.
 *
 * Values are neutral placeholders; the SHAPE is what's being derived. Runtime-free (no zod, no I/O)
 * so it can be index-exported and reached from the browser bundle.
 */
import { isPollutingKey } from "./mcp-args";
import type { FormFieldDef, NodeType } from "./types";

/** A form field's stand-in value. Empty strings for free text (the author fills in what they want
 *  to test), but a real-looking email/number/option — an `undefined`-ish value in a field a
 *  downstream `sendEmail to:` or numeric comparison reads is a test failure about the sample, not
 *  about the workflow. */
function sampleFieldValue(field: FormFieldDef): unknown {
  switch (field.type) {
    case "number":
      return 0;
    case "email":
      return "user@example.com";
    case "select":
      return field.options?.[0] ?? "";
    default:
      return "";
  }
}

/**
 * The sample input a trigger's own config implies, or `undefined` when nothing can be derived —
 * a webhook body, an MCP tool's arguments and a `start`'s caller payload are all unknowable from
 * the graph, so those stay hand-written.
 */
export function deriveSampleInput(
  type: NodeType,
  config: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const cfg = config ?? {};
  if (type === "chatTrigger") {
    // Mirrors what the chat ingress passes (`startChat` in executions.service.ts). `history` is
    // omitted: it is optional there and absent on the first turn, which is the turn worth testing.
    return { message: "Hello", sessionId: "sample-session" };
  }
  if (type === "formTrigger") {
    // INLINE `fields` only. A `templateId` form takes its inputs from a content template the canvas
    // doesn't hold, so deriving from the (then-empty) inline list would produce `{}` and quietly
    // claim the form has no fields. Nothing derived ⇒ the field stays hand-written, which is honest.
    const fields = Array.isArray(cfg.fields)
      ? (cfg.fields as FormFieldDef[])
      : [];
    // `isPollutingKey` because `out["__proto__"] = v` is a silent NO-OP (#761): the key would
    // vanish from the derived sample with no error, so the JSON we hand the author would not match
    // the form we derived it from. The save gate rejects such a field key anyway — this keeps a
    // graph written directly to the DB from producing a quietly-wrong sample.
    const usable = fields.filter(
      (f) => f && typeof f.key === "string" && f.key && !isPollutingKey(f.key),
    );
    if (!usable.length) return undefined;
    const out: Record<string, unknown> = {};
    for (const f of usable) out[f.key] = sampleFieldValue(f);
    return out;
  }
  return undefined;
}
