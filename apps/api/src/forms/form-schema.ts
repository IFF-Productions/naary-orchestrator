/**
 * JSON Schema generation for a hosted form — the contract for submitting a form WITHOUT our page.
 * Pure (no NestJS / no I/O); unit-tested in test/form-schema.spec.ts.
 *
 * Why this exists: `POST /forms/:formId` already accepts any JSON object, but a caller had no way to
 * discover what it must contain short of reading the canvas. This turns the form into a documented
 * API: `GET /forms/:formId/schema` → a JSON Schema you can validate against, generate types from, or
 * hand to a client library, then POST the payload.
 *
 * ## The invariant (one direction, deliberately)
 *
 * The generated schema is **sound, not complete**:
 *
 *     a payload the schema accepts ⇒ `validateSubmission` accepts it
 *
 * The converse is FALSE and must not be asserted, because `validateSubmission` is deliberately more
 * lenient than any schema should advertise:
 *   - it coerces a numeric STRING ("42") into a number, but the schema says `number` — telling a
 *     consumer "send a string here" would be terrible advice for a contract we control;
 *   - it STRIPS unknown keys rather than rejecting them, so `additionalProperties` is `true` (see
 *     `additionalProperties` below) — but a stricter schema would still be sound;
 *   - it treats `""` as absent, which the schema models as `minLength: 1` on required fields.
 *
 * Sound-only is exactly the guarantee a client needs ("conform to this and your POST won't 400"),
 * and it's the direction the drift test enforces. A future field type that widened
 * `validateSubmission` without touching this file could only make the schema *stricter* than
 * reality, never wrong — whereas a bidirectional claim would break on the first coercion.
 */
import type { FormFieldDef } from "@naary/dsl";
import { MAX_FIELD_LENGTH, EMAIL_PATTERN } from "./form-definition";

/** The JSON Schema dialect we emit. Draft 2020-12 is what OpenAPI 3.1 and most modern validators
 *  (ajv with the 2020 entrypoint, Pydantic, quicktype) speak natively. */
const DIALECT = "https://json-schema.org/draft/2020-12/schema";

/** Property key carrying a solved Cloudflare Turnstile token. Not a declared form field — it's
 *  stripped by `validateSubmission` — but the submit route requires it when the gate is active. */
export const TURNSTILE_PROPERTY = "turnstileToken";

/** One property in the emitted schema. Loose by design: this is JSON Schema, not our own model. */
type JsonSchemaProperty = Record<string, unknown>;

/** The emitted document. `properties`/`required` are the parts a consumer actually reads. */
export interface FormJsonSchema {
  $schema: string;
  $id?: string;
  title: string;
  description?: string;
  type: "object";
  properties: Record<string, JsonSchemaProperty>;
  required?: string[];
  additionalProperties: boolean;
  /** Non-standard annotation (JSON Schema ignores unknown keywords): how to actually submit. */
  "x-naary-submit": {
    method: "POST";
    path: string;
    /** True when the tenant's Turnstile gate is ACTIVE for this form's environment. */
    botProtection: boolean;
    notes: string[];
  };
}

/**
 * Map one declared field to its JSON Schema property. Every constraint here mirrors a check in
 * `validateSubmission` — that correspondence is what makes the schema sound, and the drift test
 * fails if one side gains a rule the other lacks.
 */
function propertyFor(field: FormFieldDef): JsonSchemaProperty {
  // `number`: validateSubmission requires a FINITE number (it rejects NaN/Infinity, and rejects
  // booleans explicitly). JSON Schema's `number` already excludes booleans and non-finite values
  // (JSON has no Infinity literal), so a bare `type: "number"` is sound.
  if (field.type === "number") {
    return { type: "number", title: field.label };
  }

  const property: JsonSchemaProperty = { type: "string", title: field.label };

  // `select`: the value must be one of the declared options.
  if (field.type === "select") {
    const options = field.options ?? [];
    // An options-less select (savable — `options` is optional in the config schema) accepts NOTHING:
    // validateSubmission tests `options ?? []`, so every value fails the membership check. That has
    // to be expressed as `not: {}` and not `enum: []`, because JSON Schema requires `enum` to be
    // non-empty — ajv rejects `enum: []` at COMPILE time, which would break a consumer's validator
    // outright rather than merely mis-describe the field.
    if (options.length === 0) {
      return {
        title: field.label,
        not: {},
        description:
          "This select has no configured options, so no value is accepted. Add options to the " +
          "form field to make it submittable.",
      };
    }
    property.enum = [...options];
    return property;
  }

  // Every other type is a length-capped string.
  property.maxLength = MAX_FIELD_LENGTH;
  // `email`: the SAME regex validateSubmission tests with, so the schema can't drift from it. JSON
  // Schema's `format: "email"` is annotation-only in most validators, hence `pattern` as well.
  if (field.type === "email") {
    property.format = "email";
    property.pattern = EMAIL_PATTERN;
  }
  // `textarea` is a string like `text` — the difference is presentational (which control the hosted
  // page renders), so it carries no extra schema constraint. Recorded for the consumer's benefit.
  if (field.type === "textarea") {
    property["x-naary-multiline"] = true;
  }
  return property;
}

/**
 * Build the JSON Schema for a form's submission body.
 *
 * `botProtection` comes from the controller (`TurnstileConfigService.publicSiteKey != null` — an
 * I/O lookup, hence a parameter). It is NOT cosmetic: when the gate is active, the submit route
 * 403s on a missing token BEFORE validating, so a headless caller obeying a schema that omitted
 * `turnstileToken` would be rejected with no clue why. When a hostname allowlist is also configured
 * the token can only be solved in a browser on an allowed origin, which makes headless submission
 * impossible — the notes say so plainly instead of implying a token is something a script can mint.
 */
export function buildFormJsonSchema(
  formId: string,
  fields: FormFieldDef[],
  opts: {
    title?: string;
    description?: string;
    botProtection: boolean;
  },
): FormJsonSchema {
  /**
   * NULL-PROTOTYPE, and this is load-bearing rather than hygiene. `field.key` is tenant-authored and
   * unconstrained (`key: z.string()`), so a field keyed `__proto__` would hit `Object.prototype`'s
   * `__proto__` setter on a plain `{}` — the assignment would set the object's prototype instead of
   * creating an own property, and `JSON.stringify` would then emit NOTHING for that field.
   *
   * That silently breaks this module's whole guarantee: the field would still be listed in
   * `required`, but with no property schema and `additionalProperties: true` a validator would
   * accept ANY value for it, while `validateSubmission` still enforces its type/pattern/length. A
   * payload the schema accepts would 400 — exactly the direction that must never fail. Verified:
   * `JSON.stringify(Object.assign({}, {"__proto__": x}))` is `{}`, while the null-prototype map keeps
   * the key. (`constructor` and other inherited names are plain own-property writes either way, but
   * a null prototype removes the whole class of surprise.)
   */
  const properties = Object.create(null) as Record<string, JsonSchemaProperty>;
  const required: string[] = [];

  for (const field of fields) {
    const property = propertyFor(field);
    if (field.placeholder) property.examples = [field.placeholder];
    if (field.required) {
      required.push(field.key);
      // `validateSubmission` treats "" as ABSENT, so a required string field rejects the empty
      // string. Without this, `{"email": ""}` would be schema-valid but 400 — breaking soundness.
      if (property.type === "string" && property.enum === undefined) {
        property.minLength = 1;
      }
    }
    properties[field.key] = property;
  }

  const notes: string[] = [];
  /**
   * Field keys that JSON Schema cannot actually constrain, so the document must not pretend
   * otherwise. `ajv` SILENTLY SKIPS a `__proto__` property — it applies neither `pattern` nor even
   * `required` (verified in form-schema.spec.ts, which pins that behaviour) — because generating an
   * accessor for it would be a pollution vector. Every mainstream validator does something similar.
   *
   * We still emit the property (it accurately describes what the endpoint accepts, and a consumer
   * that handles the key gets the real constraint), but a caller has to be told that their validator
   * will wave it through. Separately, `validateSubmission` writes the sanitized value with
   * `data[key] = raw`, and assigning a string to `__proto__` is a silent no-op — so a field with such
   * a key never reaches the workflow at all. That's a pre-existing bug worth fixing at the save gate
   * (the codebase already strips these elsewhere, see `POLLUTING_KEYS` in the DSL); until then,
   * saying so is far better than a form that appears to work and quietly discards its input.
   */
  const unenforceable = fields
    .map((f) => f.key)
    .filter(
      (k) => k === "__proto__" || k === "constructor" || k === "prototype",
    );
  if (unenforceable.length > 0) {
    notes.push(
      `The field(s) ${unenforceable.map((k) => `\`${k}\``).join(", ")} use RESERVED names and this ` +
        "form cannot be submitted at all — the endpoint rejects it with a 400 (#761). A value written " +
        "to one of those names is silently discarded by JavaScript, so it would never reach the " +
        "workflow; JSON Schema can't warn you either, since validators (ajv included) ignore " +
        "constraints on such a property entirely. Rename the field on the canvas. Newly saved forms " +
        "can no longer use these names.",
    );
  }
  if (opts.botProtection) {
    // Required in the ONLY sense that matters to a caller: omit it and the request 403s.
    properties[TURNSTILE_PROPERTY] = {
      type: "string",
      title: "Cloudflare Turnstile token",
      description:
        "A solved Turnstile token. Obtained by a browser rendering the widget — it cannot be " +
        "generated server-side.",
    };
    required.push(TURNSTILE_PROPERTY);
    notes.push(
      "This form is bot-protected: a solved Turnstile token must be sent as " +
        `\`${TURNSTILE_PROPERTY}\` or the request is rejected with 403. Turnstile tokens are ` +
        "single-use and browser-solved, so submitting this form from a script is not supported " +
        "while bot protection is enabled. Use the hosted page, or disable bot protection for " +
        "this environment.",
    );
  }
  notes.push(
    'A successful submission returns 202 with `{"status":"started"}`. It carries no run ' +
      "identifier — the workflow may still be running (or waiting on a human).",
  );
  notes.push(
    "Undeclared properties are accepted but silently discarded — only the fields above ever " +
      "reach the workflow.",
  );

  return {
    $schema: DIALECT,
    $id: `/forms/${formId}/schema`,
    title: opts.title ?? "Form submission",
    ...(opts.description ? { description: opts.description } : {}),
    type: "object",
    properties,
    ...(required.length ? { required } : {}),
    // `true` mirrors reality: validateSubmission STRIPS unknown keys instead of rejecting them, so
    // a payload with extras really is accepted. Claiming `false` would make the schema unsound in
    // the direction that matters (it would reject payloads the endpoint happily takes).
    additionalProperties: true,
    "x-naary-submit": {
      method: "POST",
      path: `/forms/${formId}`,
      botProtection: opts.botProtection,
      notes,
    },
  };
}
