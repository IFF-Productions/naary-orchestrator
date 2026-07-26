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
import type {
  FormBrandingConfig,
  FormFieldDef,
  FormTriggerNodeConfig,
  GraphDef,
  TemplateBlock,
} from "@naary/dsl";

/** Public view of a form — safe to serve to an anonymous browser. Carries NO tenant/workflow ids. */
export interface FormDefinition {
  formId: string;
  title?: string;
  description?: string;
  submitLabel?: string;
  fields: FormFieldDef[];
  /**
   * The template's ordered blocks, present ONLY when a form template drives this form (Slice 4c).
   * Lets the public page render content blocks (heading/text/image/…) INTERLEAVED with the input
   * fields, matching what the block editor previews — instead of fields-only. Each block is
   * re-projected to its known union shape (see `projectPublicBlock`) so no unexpected/authoring key
   * rides out to the browser. `fields` stays authoritative for submission validation; the field
   * blocks here and `fields` are derived from the SAME array, so they can't drift.
   */
  blocks?: TemplateBlock[];
  /**
   * Hosted-page presentation, re-projected to the known keys (see `projectBranding`). Absent when the
   * author set none, so the page renders exactly as it did before branding existed.
   */
  branding?: FormBrandingConfig;
  /** Cloudflare Turnstile public site key — present only when the tenant has an ACTIVE bot gate for
   *  this env (added by the controller, not this pure extractor). The page renders the widget and
   *  sends the solved token back on submit. */
  turnstileSiteKey?: string;
}

/** Exactly `#rrggbb`. Mirrors the save-time check in `CONFIG_SCHEMAS.formTrigger`; re-tested here
 *  because the value lands in a CSS custom property and a graph row can be written without passing
 *  through the save gate (a direct DB write, or a row predating the constraint). */
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

/** Asset-id shape (uuid). Mirrors the save gate; a logo is always an id WE issued, never a URL. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Re-project the author's branding to the known keys and DISCARD anything that fails the same checks
 * the save gate applies. Drop-on-read, never repair: a rejected `accentColor` falls back to the
 * default ember, and a rejected `redirectUrl` falls back to the success card. Both are correct
 * degradations — the alternative (serving an unvalidated value to an anonymous browser) turns an
 * authoring mistake into an injection.
 *
 * The redirect check is intentionally duplicated rather than imported from the zod schema: this is
 * the LAST gate before the value reaches a visitor's browser, and it must hold for a graph that
 * never passed through `POST /graphs` at all.
 */
function projectBranding(raw: unknown): FormBrandingConfig | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const b = raw as Record<string, unknown>;
  const out: FormBrandingConfig = {};

  if (typeof b.successTitle === "string" && b.successTitle.trim()) {
    out.successTitle = b.successTitle.slice(0, 200);
  }
  if (typeof b.successMessage === "string" && b.successMessage.trim()) {
    out.successMessage = b.successMessage.slice(0, 2_000);
  }
  // https only, no embedded credentials — see the zod schema for why each clause is load-bearing.
  if (
    typeof b.redirectUrl === "string" &&
    b.redirectUrl.length <= 2_000 &&
    /^https:\/\//i.test(b.redirectUrl) &&
    !/^https:\/\/[^/?#]*@/i.test(b.redirectUrl)
  ) {
    out.redirectUrl = b.redirectUrl;
  }
  if (typeof b.accentColor === "string" && HEX_COLOR_RE.test(b.accentColor)) {
    out.accentColor = b.accentColor;
  }
  if (b.theme === "light" || b.theme === "dark" || b.theme === "auto") {
    out.theme = b.theme;
  }
  if (b.desktopColumns === 1 || b.desktopColumns === 2) {
    out.desktopColumns = b.desktopColumns;
  }
  if (b.width === "narrow" || b.width === "wide") out.width = b.width;
  // An asset id we issued (uuid shape). Never a URL — see FormBrandingConfig.logoAssetId. Ownership
  // was verified at save time; a shape check is all that's needed here, and a stale id resolves to a
  // 404 image rather than anything harmful.
  if (typeof b.logoAssetId === "string" && UUID_RE.test(b.logoAssetId)) {
    out.logoAssetId = b.logoAssetId;
  }
  if (typeof b.logoAlt === "string" && b.logoAlt.trim()) {
    out.logoAlt = b.logoAlt.slice(0, 120);
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

/** Cap on a single submitted value's length — an anonymous caller can't push a megabyte string
 *  into the workflow ctx (the whole payload is additionally bounded by the body-size limit). */
export const MAX_FIELD_LENGTH = 10_000;

/**
 * Loose email shape check — deliberately permissive (real deliverability isn't our job), just
 * enough that a `type: "email"` field can't carry arbitrary multi-line junk.
 *
 * Exported as a PATTERN STRING because `form-schema.ts` emits it as a JSON Schema `pattern` for
 * `type: "email"` fields. Sharing the source (rather than re-typing the regex there) is what makes
 * "schema-valid ⇒ this validator accepts" hold for email by construction instead of by luck.
 */
export const EMAIL_PATTERN = "^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$";
const EMAIL_RE = new RegExp(EMAIL_PATTERN);

/** The formTrigger entry node's referenced form-template id, if any (Slice 4b). Returns undefined
 *  when the entry isn't a formTrigger or carries no `templateId` — the caller then serves inline
 *  fields with no template lookup. Pure; the actual template load is I/O in the controller. */
export function formTemplateId(graph: GraphDef): string | undefined {
  const entry = graph.nodes.find((n) => n.id === graph.startNodeId);
  if (!entry || entry.type !== "formTrigger") return undefined;
  const cfg = (entry.config ?? {}) as Partial<FormTriggerNodeConfig>;
  return typeof cfg.templateId === "string" && cfg.templateId
    ? cfg.templateId
    : undefined;
}

/** Project a form template's `field` blocks to the public FormFieldDef list — the authoritative set
 *  the POST route validates against. Content blocks are skipped here (they carry no submittable
 *  value); the public page still RENDERS them via the served `blocks` array (Slice 4c). The block
 *  model has no `placeholder`, so it's simply absent from a template-sourced field. */
function fieldsFromBlocks(blocks: TemplateBlock[]): FormFieldDef[] {
  const out: FormFieldDef[] = [];
  for (const b of blocks) {
    if (b.type !== "field") continue;
    out.push({
      key: b.key,
      label: b.label,
      type: b.fieldType,
      ...(b.required ? { required: true } : {}),
      ...(b.fieldType === "select" && Array.isArray(b.options)
        ? { options: b.options }
        : {}),
    });
  }
  return out;
}

/**
 * Re-project one template block to only the known keys of its union variant — a tight allowlist so
 * no authoring/unknown key ever rides out to the anonymous browser (mirrors the field re-projection;
 * stored blocks are already zod-validated on write, this is defense-in-depth). Field blocks are
 * included so the public page can render inputs INTERLEAVED with content in the authored order.
 */
function projectPublicBlock(b: TemplateBlock): TemplateBlock {
  switch (b.type) {
    case "heading":
      return { id: b.id, type: "heading", level: b.level, text: b.text };
    case "text":
      return { id: b.id, type: "text", html: b.html };
    case "image":
      return {
        id: b.id,
        type: "image",
        src: b.src,
        ...(b.alt ? { alt: b.alt } : {}),
      };
    case "button":
      return { id: b.id, type: "button", label: b.label, href: b.href };
    case "divider":
      return { id: b.id, type: "divider" };
    case "spacer":
      return { id: b.id, type: "spacer", size: b.size };
    case "field":
      return {
        id: b.id,
        type: "field",
        key: b.key,
        label: b.label,
        fieldType: b.fieldType,
        required: b.required,
        ...(b.fieldType === "select" && Array.isArray(b.options)
          ? { options: b.options }
          : {}),
      };
  }
}

/**
 * Read the public form definition from a graph. The graph's ENTRY node must be a `formTrigger`
 * (a form endpoint whose graph was later re-pointed at a webhook/other entry is not a form) —
 * returns null otherwise so the caller 404s. Sanitizes the served field list to the known keys
 * so no unexpected config rides out to the browser.
 *
 * `templateBlocks` (Slice 4b): the blocks of the node's referenced form template, loaded by the
 * controller. When non-null the served fields come from its `field` blocks; when null (no
 * reference, or a deleted/missing/non-form template) it falls back to the node's inline `fields`,
 * mirroring how `sendEmail` falls back to its inline body. title/description/submitLabel always
 * come from the node config (a form template carries none). Both the GET-definition and
 * POST-submit routes call this so the served and validated field sets are always identical.
 */
export function extractFormDefinition(
  graph: GraphDef,
  formId: string,
  templateBlocks?: TemplateBlock[] | null,
): FormDefinition | null {
  const entry = graph.nodes.find((n) => n.id === graph.startNodeId);
  if (!entry || entry.type !== "formTrigger") return null;
  const cfg = (entry.config ?? {}) as Partial<FormTriggerNodeConfig>;
  const fields: FormFieldDef[] =
    templateBlocks != null
      ? fieldsFromBlocks(templateBlocks)
      : Array.isArray(cfg.fields)
        ? cfg.fields
        : [];
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
    // Presentation, re-projected + re-validated (projectBranding). Comes from the NODE even when a
    // template drives the fields — a form template carries content blocks, not page chrome, exactly
    // like title/description/submitLabel above.
    ...(() => {
      const branding = projectBranding((cfg as { branding?: unknown }).branding);
      return branding ? { branding } : {};
    })(),
    // A template drives this form → serve its ordered blocks (projected) so the page can render
    // content interleaved with fields. Inline forms carry no blocks (the flat `fields` render).
    ...(templateBlocks != null
      ? { blocks: templateBlocks.map(projectPublicBlock) }
      : {}),
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
    /**
     * #761: a field keyed `__proto__`/`constructor`/`prototype` cannot work. `data[key] = value`
     * writes a string to `obj.__proto__`, which is a silent NO-OP — the value is discarded and the
     * workflow receives the field as absent, with no error anywhere.
     *
     * The save gate now rejects such keys, so this only fires for a form saved BEFORE that gate
     * existed. It refuses the submission rather than continuing, because the alternative is exactly
     * the failure being fixed: a visitor told their submission succeeded while part of it was thrown
     * away. Naming the field points the author at the fix (rename it on the canvas).
     */
    if (
      field.key === "__proto__" ||
      field.key === "constructor" ||
      field.key === "prototype"
    ) {
      return {
        ok: false,
        error: `Field ${field.key} uses a reserved name and cannot be submitted — rename it in the form's configuration.`,
      };
    }

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
