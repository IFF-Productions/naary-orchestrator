import Ajv2020 from "ajv/dist/2020";
import type { ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import type { FormFieldDef } from "@naary/dsl";
import { describe, expect, it } from "vitest";
import {
  MAX_FIELD_LENGTH,
  validateSubmission,
} from "../src/forms/form-definition";
import {
  TURNSTILE_PROPERTY,
  buildFormJsonSchema,
} from "../src/forms/form-schema";

/**
 * The emitted JSON Schema is the PUBLIC CONTRACT for submitting a form headlessly, so its only real
 * requirement is that obeying it works. This suite enforces that as a one-directional implication
 * over a generated cross-product, not over hand-picked examples:
 *
 *     ajv says the payload is schema-valid  ⇒  validateSubmission accepts it
 *
 * A counterexample means we published a contract that 400s — the single worst outcome for this
 * feature. The converse is deliberately NOT asserted: validateSubmission coerces numeric strings,
 * strips unknown keys and treats "" as absent, so it accepts plenty the schema doesn't advertise
 * (see the module doc in src/forms/form-schema.ts).
 */

/** ajv with `format` support installed, so `format: "email"` is actually checked rather than
 *  ignored — otherwise the test would be laxer than a real consumer's validator. */
function validator(schema: unknown): ValidateFunction {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  return ajv.compile(schema as object);
}

const OPTIONS = ["Low", "High"];

/** Every declared field type, each in a required and an optional flavour — the full matrix the
 *  generator has to handle. Keys are stable so payloads below can address them. */
function fieldMatrix(): FormFieldDef[][] {
  const types: FormFieldDef["type"][] = [
    "text",
    "textarea",
    "number",
    "email",
    "select",
  ];
  const sets: FormFieldDef[][] = [];
  for (const type of types) {
    for (const required of [false, true]) {
      const base: FormFieldDef = {
        key: "value",
        label: `A ${type}`,
        type,
        ...(required ? { required: true } : {}),
        ...(type === "select" ? { options: OPTIONS } : {}),
      };
      sets.push([base]);
    }
  }
  // A multi-field form too, so interactions (one field valid, another missing) are covered.
  sets.push([
    { key: "email", label: "Email", type: "email", required: true },
    { key: "name", label: "Name", type: "text" },
    { key: "age", label: "Age", type: "number" },
    { key: "value", label: "Priority", type: "select", options: OPTIONS },
  ]);
  return sets;
}

/**
 * Candidate values probing every boundary the two implementations could disagree on: emptiness,
 * type confusion, the length cap either side of the limit, non-finite numbers, email shapes, values
 * outside a select's options, and prototype-pollution keys.
 */
const VALUES: unknown[] = [
  undefined,
  null,
  "",
  " ",
  "Low",
  "High",
  "Medium", // not an option
  "plain text",
  "user@example.com",
  "not-an-email",
  "user@example", // no TLD dot — rejected by the shared pattern
  "a@b.c",
  0,
  42,
  -1,
  3.5,
  1e308,
  "42", // numeric string: validateSubmission coerces, the schema says number
  "1e400", // → Infinity when coerced
  true,
  false,
  {},
  [],
  { nested: "object" },
  "x".repeat(MAX_FIELD_LENGTH),
  "x".repeat(MAX_FIELD_LENGTH + 1),
];

/** Bodies to submit: each candidate under each addressed key, plus shapes that aren't objects. */
function payloads(fields: FormFieldDef[]): unknown[] {
  const out: unknown[] = [
    {},
    // Non-object bodies: validateSubmission rejects these, and `type: "object"` must too.
    null,
    [],
    "a string",
    42,
    // Unknown keys only — accepted-and-stripped, so additionalProperties must not forbid them.
    { unexpected: "value" },
    { __proto__: { polluted: true } },
    { constructor: "x" },
  ];
  for (const field of fields) {
    for (const v of VALUES) {
      out.push({ [field.key]: v });
      // With an extra unknown key alongside, to pin additionalProperties behaviour.
      out.push({ [field.key]: v, extra: "ignored" });
    }
  }
  // A fully-populated body for the multi-field case.
  if (fields.length > 1) {
    out.push({
      email: "user@example.com",
      name: "Ada",
      age: 36,
      value: "Low",
    });
  }
  return out;
}

describe("a schema-valid payload is always accepted by validateSubmission", () => {
  it.each(
    fieldMatrix().map(
      (fields) =>
        [
          `${fields.map((f) => `${f.type}${f.required ? "!" : ""}`).join("+")}`,
          fields,
        ] as const,
    ),
  )("%s", (_label, fields) => {
    const validate = validator(
      buildFormJsonSchema("form-1", fields, { botProtection: false }),
    );
    let accepted = 0;
    for (const body of payloads(fields)) {
      if (!validate(body)) continue; // schema rejects it — says nothing about the endpoint
      accepted++;
      const result = validateSubmission(fields, body);
      expect(
        result.ok,
        `schema accepted ${JSON.stringify(body)} but validateSubmission rejected it: ${
          result.ok ? "" : result.error
        }`,
      ).toBe(true);
    }
    // Guard against a vacuous pass: a schema that accepts nothing would satisfy the implication
    // trivially. Every field set must admit at least a few valid bodies.
    expect(
      accepted,
      "schema accepted no payload at all — test is vacuous",
    ).toBeGreaterThan(2);
  });

  /** And the corpus must actually exercise rejection, or it isn't probing the boundary. */
  it("the corpus contains payloads the schema rejects", () => {
    const fields: FormFieldDef[] = [
      { key: "value", label: "Email", type: "email", required: true },
    ];
    const validate = validator(
      buildFormJsonSchema("form-1", fields, { botProtection: false }),
    );
    const rejected = payloads(fields).filter((b) => !validate(b));
    expect(rejected.length).toBeGreaterThan(5);
  });
});

describe("the emitted constraints mirror validateSubmission's checks", () => {
  const schemaFor = (fields: FormFieldDef[], botProtection = false) =>
    buildFormJsonSchema("form-1", fields, { botProtection });

  it("a required string field forbids the empty string (validateSubmission treats it as absent)", () => {
    const fields: FormFieldDef[] = [
      { key: "name", label: "Name", type: "text", required: true },
    ];
    expect(schemaFor(fields).properties.name.minLength).toBe(1);
    expect(schemaFor(fields).required).toEqual(["name"]);
    // The behaviour that motivates it: "" is rejected by BOTH sides.
    expect(validator(schemaFor(fields))({ name: "" })).toBe(false);
    expect(validateSubmission(fields, { name: "" }).ok).toBe(false);
  });

  it("an optional field is not required and carries no minLength", () => {
    const fields: FormFieldDef[] = [
      { key: "name", label: "Name", type: "text" },
    ];
    const schema = schemaFor(fields);
    expect(schema.required).toBeUndefined();
    expect(schema.properties.name.minLength).toBeUndefined();
    // "" on an OPTIONAL field is accepted by both (omitted from the workflow input).
    expect(validator(schema)({ name: "" })).toBe(true);
    expect(validateSubmission(fields, { name: "" }).ok).toBe(true);
  });

  it("caps string length at the same MAX_FIELD_LENGTH the validator enforces", () => {
    const fields: FormFieldDef[] = [
      { key: "note", label: "Note", type: "textarea" },
    ];
    expect(schemaFor(fields).properties.note.maxLength).toBe(MAX_FIELD_LENGTH);
  });

  it("emits the select's options as an enum", () => {
    const fields: FormFieldDef[] = [
      { key: "p", label: "Priority", type: "select", options: OPTIONS },
    ];
    expect(schemaFor(fields).properties.p.enum).toEqual(OPTIONS);
  });

  /**
   * An options-less select accepts NOTHING (validateSubmission checks `options ?? []`, so every
   * value fails membership). The schema must say that rather than imply any string is fine — and it
   * must do so with `not: {}`, NOT `enum: []`: JSON Schema requires `enum` to be non-empty and ajv
   * throws "enum must have non-empty array" at COMPILE time, which would break a consumer's
   * validator on the whole document instead of just mis-describing one field.
   */
  it("an options-less select rejects every value without breaking compilation", () => {
    const fields: FormFieldDef[] = [
      { key: "p", label: "Priority", type: "select" },
    ];
    const schema = schemaFor(fields);
    expect(schema.properties.p.enum).toBeUndefined();
    expect(schema.properties.p.not).toEqual({});
    // Compiles (the regression this guards), and agrees with the validator: nothing is accepted.
    const validate = validator(schema);
    expect(validate({ p: "anything" })).toBe(false);
    expect(validateSubmission(fields, { p: "anything" }).ok).toBe(false);
    // The key being absent is governed by `required`, so an optional one still accepts {}.
    expect(validate({})).toBe(true);
    expect(validateSubmission(fields, {}).ok).toBe(true);
  });

  it("emits the shared email pattern, so the two cannot drift", () => {
    const fields: FormFieldDef[] = [
      { key: "e", label: "Email", type: "email" },
    ];
    const pattern = schemaFor(fields).properties.e.pattern as string;
    expect(pattern).toBeTypeOf("string");
    // Same verdict from the emitted pattern and from the validator, on both sides of the boundary.
    for (const candidate of ["a@b.c", "no-at-sign", "a@b", "a b@c.d"]) {
      expect(
        new RegExp(pattern).test(candidate),
        `pattern disagrees on ${candidate}`,
      ).toBe(validateSubmission(fields, { e: candidate }).ok);
    }
  });

  it("allows undeclared properties, because the endpoint strips rather than rejects them", () => {
    const fields: FormFieldDef[] = [
      { key: "name", label: "Name", type: "text" },
    ];
    const schema = schemaFor(fields);
    expect(schema.additionalProperties).toBe(true);
    expect(validator(schema)({ name: "Ada", surprise: 1 })).toBe(true);
    const result = validateSubmission(fields, { name: "Ada", surprise: 1 });
    expect(result.ok && result.data).toEqual({ name: "Ada" }); // stripped
  });
});

describe("bot protection is disclosed, not hidden", () => {
  const fields: FormFieldDef[] = [{ key: "name", label: "Name", type: "text" }];

  /**
   * The reason this matters: `POST /forms/:formId` verifies Turnstile BEFORE validating the body and
   * 403s on a missing token. A schema that omitted `turnstileToken` would describe a request that
   * cannot succeed — the caller would blame their credential, not the gate.
   */
  it("names turnstileToken as required when the gate is active", () => {
    const schema = buildFormJsonSchema("form-1", fields, {
      botProtection: true,
    });
    expect(schema.required).toContain(TURNSTILE_PROPERTY);
    expect(schema.properties[TURNSTILE_PROPERTY]).toBeDefined();
    expect(schema["x-naary-submit"].botProtection).toBe(true);
  });

  /** And says outright that a script can't solve one, instead of implying a token is mintable. */
  it("warns that headless submission is unsupported while the gate is on", () => {
    const notes = buildFormJsonSchema("form-1", fields, {
      botProtection: true,
    })["x-naary-submit"].notes.join(" ");
    expect(notes).toMatch(/browser-solved/i);
    expect(notes).toMatch(/not supported/i);
  });

  it("omits it entirely when no gate is active", () => {
    const schema = buildFormJsonSchema("form-1", fields, {
      botProtection: false,
    });
    expect(schema.properties[TURNSTILE_PROPERTY]).toBeUndefined();
    expect(schema.required ?? []).not.toContain(TURNSTILE_PROPERTY);
    expect(schema["x-naary-submit"].botProtection).toBe(false);
  });

  /** turnstileToken is not a declared field, so it must never reach the workflow input. */
  it("the advertised token is stripped from the workflow input", () => {
    const result = validateSubmission(fields, {
      name: "Ada",
      [TURNSTILE_PROPERTY]: "solved-token",
    });
    expect(result.ok && result.data).toEqual({ name: "Ada" });
  });
});

describe("the document is a usable JSON Schema", () => {
  const fields: FormFieldDef[] = [
    { key: "email", label: "Email", type: "email", required: true },
  ];

  it("declares draft 2020-12 and compiles", () => {
    const schema = buildFormJsonSchema("form-1", fields, {
      botProtection: false,
    });
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(() => validator(schema)).not.toThrow();
    expect(schema.type).toBe("object");
  });

  it("points at the submit route it describes", () => {
    const schema = buildFormJsonSchema("abc-123", fields, {
      botProtection: false,
    });
    expect(schema["x-naary-submit"]).toMatchObject({
      method: "POST",
      path: "/forms/abc-123",
    });
    expect(schema.$id).toBe("/forms/abc-123/schema");
  });

  it("carries the form's own title and description when set", () => {
    const schema = buildFormJsonSchema("form-1", fields, {
      title: "Contact us",
      description: "We reply within a day.",
      botProtection: false,
    });
    expect(schema.title).toBe("Contact us");
    expect(schema.description).toBe("We reply within a day.");
  });

  it("carries a placeholder through as an example", () => {
    const schema = buildFormJsonSchema(
      "form-1",
      [
        {
          key: "email",
          label: "Email",
          type: "email",
          placeholder: "you@example.com",
        },
      ],
      { botProtection: false },
    );
    expect(schema.properties.email.examples).toEqual(["you@example.com"]);
  });

  it("handles a form with no fields at all", () => {
    const schema = buildFormJsonSchema("form-1", [], {
      botProtection: false,
    });
    expect(schema.properties).toEqual({});
    expect(schema.required).toBeUndefined();
    expect(validator(schema)({})).toBe(true);
  });
});
