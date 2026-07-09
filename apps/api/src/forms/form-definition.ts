/**
 * Pure (no NestJS / no I/O) form-definition extraction + submission validation for the hosted
 * public form endpoint. Unit-tested in test/form-definition.spec.ts.
 *
 * A form endpoint resolves to the tenant's CURRENT graph; this module reads the graph's entry
 * node — which MUST be a `formTrigger` — and exposes only a public view of its field schema (no
 * tenant identifiers). It also validates + sanitizes an anonymous submission against that schema
 * before it becomes a workflow's trigger input: unknown keys are stripped, required fields are
 * enforced, per-type coercion runs, and oversized values are rejected — so nothing an anonymous
 * caller sends reaches the interpreter unchecked.
 */
import type { FormFieldDef, FormTriggerNodeConfig, GraphDef } from "@naary/dsl";

/** Public view of a form — safe to serve to an anonymous browser. Carries NO tenant/workflow ids. */
export interface FormDefinition {
  formId: string;
  title?: string;
  description?: string;
  submitLabel?: string;
  fields: FormFieldDef[];
}

/** Cap on a single submitted value's length — an anonymous caller can't push a megabyte string
 *  into the workflow ctx (the whole payload is additionally bounded by the body-size limit). */
export const MAX_FIELD_LENGTH = 10_000;

/** Loose email shape check — deliberately permissive (real deliverability isn't our job), just
 *  enough that a `type: "email"` field can't carry arbitrary multi-line junk. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Read the public form definition from a graph. The graph's ENTRY node must be a `formTrigger`
 * (a form endpoint whose graph was later re-pointed at a webhook/other entry is not a form) —
 * returns null otherwise so the caller 404s. Sanitizes the served field list to the known keys
 * so no unexpected config rides out to the browser.
 */
export function extractFormDefinition(
  graph: GraphDef,
  formId: string,
): FormDefinition | null {
  const entry = graph.nodes.find((n) => n.id === graph.startNodeId);
  if (!entry || entry.type !== "formTrigger") return null;
  const cfg = (entry.config ?? {}) as Partial<FormTriggerNodeConfig>;
  const fields: FormFieldDef[] = Array.isArray(cfg.fields) ? cfg.fields : [];
  return {
    formId,
    ...(cfg.title ? { title: cfg.title } : {}),
    ...(cfg.description ? { description: cfg.description } : {}),
    ...(cfg.submitLabel ? { submitLabel: cfg.submitLabel } : {}),
    // Re-project each field to only the known keys (don't echo unknown config to the browser).
    fields: fields.map((f) => ({
      key: f.key,
      label: f.label,
      type: f.type,
      ...(f.required ? { required: true } : {}),
      ...(f.placeholder ? { placeholder: f.placeholder } : {}),
      ...(f.type === "select" && Array.isArray(f.options)
        ? { options: f.options }
        : {}),
    })),
  };
}

export type SubmissionResult =
  { ok: true; data: Record<string, unknown> } | { ok: false; error: string };

/**
 * Validate + sanitize an anonymous submission against the declared fields. The returned `data`
 * contains ONLY declared keys, coerced to the field's type — it's what becomes the workflow's
 * trigger input. Any structural problem returns `{ ok: false, error }` for a 400 (never throws).
 */
export function validateSubmission(
  fields: FormFieldDef[],
  body: unknown,
): SubmissionResult {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Submission must be a JSON object" };
  }
  const input = body as Record<string, unknown>;
  const data: Record<string, unknown> = {};

  for (const field of fields) {
    const raw = input[field.key];
    const present = raw !== undefined && raw !== null && raw !== "";

    if (!present) {
      if (field.required) {
        return { ok: false, error: `Missing required field: ${field.key}` };
      }
      continue; // optional + absent → omit (don't emit undefined into the ctx)
    }

    if (field.type === "number") {
      // Reject an oversized numeric string before coercing (the string branch's length cap
      // doesn't run for numbers), and require a finite result (a huge value → Infinity → null).
      if (typeof raw === "string" && raw.length > MAX_FIELD_LENGTH) {
        return {
          ok: false,
          error: `Field ${field.key} exceeds ${MAX_FIELD_LENGTH} characters`,
        };
      }
      const n = typeof raw === "number" ? raw : Number(raw);
      if (typeof raw === "boolean" || !Number.isFinite(n)) {
        return { ok: false, error: `Field ${field.key} must be a number` };
      }
      data[field.key] = n;
      continue;
    }

    // Every non-number field is a string. Reject non-string/non-primitive shapes and oversize.
    if (typeof raw !== "string") {
      return { ok: false, error: `Field ${field.key} must be text` };
    }
    if (raw.length > MAX_FIELD_LENGTH) {
      return {
        ok: false,
        error: `Field ${field.key} exceeds ${MAX_FIELD_LENGTH} characters`,
      };
    }
    if (field.type === "email" && !EMAIL_RE.test(raw)) {
      return {
        ok: false,
        error: `Field ${field.key} must be an email address`,
      };
    }
    if (field.type === "select") {
      const options = field.options ?? [];
      if (!options.includes(raw)) {
        return { ok: false, error: `Field ${field.key} is not a valid choice` };
      }
    }
    data[field.key] = raw;
  }

  return { ok: true, data };
}
