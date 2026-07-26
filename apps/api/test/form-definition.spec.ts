import { describe, expect, it } from "vitest";
import type { FormFieldDef, GraphDef } from "@naary/dsl";
import {
  MAX_FIELD_LENGTH,
  extractFormDefinition,
  validateSubmission,
} from "../src/forms/form-definition";

const FIELDS: FormFieldDef[] = [
  { key: "email", label: "Email", type: "email", required: true },
  { key: "name", label: "Name", type: "text" },
  { key: "age", label: "Age", type: "number" },
  {
    key: "priority",
    label: "Priority",
    type: "select",
    options: ["Low", "High"],
  },
];

function formGraph(config: unknown): GraphDef {
  return {
    startNodeId: "form",
    nodes: [
      { id: "form", type: "formTrigger", config: config as never },
      { id: "end", type: "end" },
    ],
    edges: [{ from: "form", to: "end" }],
  };
}

describe("extractFormDefinition", () => {
  it("returns the public definition when the entry node is a formTrigger", () => {
    const def = extractFormDefinition(
      formGraph({ title: "Contact", submitLabel: "Send", fields: FIELDS }),
      "f-1",
    );
    expect(def).toEqual({
      formId: "f-1",
      title: "Contact",
      submitLabel: "Send",
      fields: [
        { key: "email", label: "Email", type: "email", required: true },
        { key: "name", label: "Name", type: "text" },
        { key: "age", label: "Age", type: "number" },
        {
          key: "priority",
          label: "Priority",
          type: "select",
          options: ["Low", "High"],
        },
      ],
    });
  });

  it("returns null when the entry node is NOT a formTrigger (re-pointed graph)", () => {
    const graph: GraphDef = {
      startNodeId: "wh",
      nodes: [
        { id: "wh", type: "webhookTrigger" },
        { id: "end", type: "end" },
      ],
      edges: [{ from: "wh", to: "end" }],
    };
    expect(extractFormDefinition(graph, "f-1")).toBeNull();
  });

  it("tolerates a missing fields array (empty form)", () => {
    const def = extractFormDefinition(formGraph({ title: "Empty" }), "f-1");
    expect(def?.fields).toEqual([]);
  });

  it("does not echo unknown config keys out to the browser", () => {
    const def = extractFormDefinition(
      formGraph({ secretInternal: "x", fields: [] }),
      "f-1",
    );
    expect(def).not.toHaveProperty("secretInternal");
  });

  // --- Slice 4b: fields sourced from a referenced form template's blocks ---

  it("derives fields from a template AND serves its ordered blocks (content interleaved)", () => {
    const blocks = [
      { id: "b1", type: "heading", level: 1, text: "Welcome" },
      {
        id: "b2",
        type: "field",
        key: "email",
        label: "Email",
        fieldType: "email",
        required: true,
      },
      { id: "b3", type: "divider" },
      {
        id: "b4",
        type: "field",
        key: "tier",
        label: "Tier",
        fieldType: "select",
        required: false,
        options: ["A", "B"],
      },
    ] as never;
    const def = extractFormDefinition(
      // Inline fields present but IGNORED while a template drives the form.
      formGraph({ title: "T", templateId: "tpl-1", fields: FIELDS }),
      "f-1",
      blocks,
    );
    expect(def).toEqual({
      formId: "f-1",
      title: "T",
      // fields (validation authority) come from the field blocks…
      fields: [
        { key: "email", label: "Email", type: "email", required: true },
        { key: "tier", label: "Tier", type: "select", options: ["A", "B"] },
      ],
      // …and the FULL ordered block list is served for interleaved rendering.
      blocks: [
        { id: "b1", type: "heading", level: 1, text: "Welcome" },
        {
          id: "b2",
          type: "field",
          key: "email",
          label: "Email",
          fieldType: "email",
          required: true,
        },
        { id: "b3", type: "divider" },
        {
          id: "b4",
          type: "field",
          key: "tier",
          label: "Tier",
          fieldType: "select",
          required: false,
          options: ["A", "B"],
        },
      ],
    });
  });

  it("inline (no-template) form carries NO blocks — just the flat fields", () => {
    const def = extractFormDefinition(
      formGraph({ title: "Inline", fields: FIELDS }),
      "f-1",
    );
    expect(def).not.toHaveProperty("blocks");
  });

  it("tightly projects served blocks — an unknown/authoring key is stripped", () => {
    const blocks = [
      {
        id: "b1",
        type: "heading",
        level: 2,
        text: "Hi",
        secretInternal: "x", // must NOT reach the browser
      },
      {
        id: "b2",
        type: "field",
        key: "email",
        label: "Email",
        fieldType: "email",
        required: true,
        adminOnly: true, // must NOT reach the browser
      },
    ] as never;
    const def = extractFormDefinition(
      formGraph({ templateId: "tpl-1", fields: [] }),
      "f-1",
      blocks,
    );
    expect(JSON.stringify(def)).not.toContain("secretInternal");
    expect(JSON.stringify(def)).not.toContain("adminOnly");
    expect(def?.blocks?.[0]).toEqual({
      id: "b1",
      type: "heading",
      level: 2,
      text: "Hi",
    });
  });

  it("falls back to the inline fields when the template is deleted/missing (null blocks)", () => {
    const def = extractFormDefinition(
      formGraph({ templateId: "gone", fields: FIELDS }),
      "f-1",
      null,
    );
    expect(def?.fields).toEqual(FIELDS);
  });

  it("round-trips: template-derived fields validate a submission (GET/POST agree)", () => {
    const blocks = [
      {
        id: "b1",
        type: "field",
        key: "email",
        label: "Email",
        fieldType: "email",
        required: true,
      },
      {
        id: "b2",
        type: "field",
        key: "note",
        label: "Note",
        fieldType: "text",
        required: false,
      },
    ] as never;
    const def = extractFormDefinition(
      formGraph({ templateId: "tpl-1", fields: [] }),
      "f-1",
      blocks,
    );
    // The SAME derived field set that GET serves is what POST validates against.
    const res = validateSubmission(def?.fields ?? [], {
      email: "a@b.com",
      note: "hi",
      injected: "DROP TABLE", // unknown key must be stripped
    });
    expect(res).toEqual({
      ok: true,
      data: { email: "a@b.com", note: "hi" },
    });
  });
});

describe("validateSubmission", () => {
  it("accepts a valid submission and returns ONLY declared keys, coerced", () => {
    const res = validateSubmission(FIELDS, {
      email: "a@b.com",
      name: "Sam",
      age: "42",
      priority: "High",
      injected: "DROP TABLE", // unknown key — must be stripped
    });
    expect(res).toEqual({
      ok: true,
      data: { email: "a@b.com", name: "Sam", age: 42, priority: "High" },
    });
  });

  it("rejects a missing required field", () => {
    const res = validateSubmission(FIELDS, { name: "Sam" });
    expect(res).toEqual({ ok: false, error: expect.stringMatching(/email/) });
  });

  it("omits optional absent fields (no undefined into the ctx)", () => {
    const res = validateSubmission(FIELDS, { email: "a@b.com" });
    expect(res.ok && res.data).toEqual({ email: "a@b.com" });
  });

  it("rejects a non-numeric number field", () => {
    const res = validateSubmission(FIELDS, { email: "a@b.com", age: "notnum" });
    expect(res).toEqual({ ok: false, error: expect.stringMatching(/number/) });
  });

  it("rejects a bad email", () => {
    const res = validateSubmission(FIELDS, { email: "not-an-email" });
    expect(res).toEqual({ ok: false, error: expect.stringMatching(/email/) });
  });

  it("rejects a select value outside its options", () => {
    const res = validateSubmission(FIELDS, {
      email: "a@b.com",
      priority: "Urgent",
    });
    expect(res).toEqual({ ok: false, error: expect.stringMatching(/choice/) });
  });

  it("rejects an oversized field value", () => {
    const res = validateSubmission(FIELDS, {
      email: "a@b.com",
      name: "x".repeat(MAX_FIELD_LENGTH + 1),
    });
    expect(res).toEqual({
      ok: false,
      error: expect.stringMatching(/exceeds/),
    });
  });

  it("rejects an oversized numeric string (no Infinity into the ctx)", () => {
    const res = validateSubmission(FIELDS, {
      email: "a@b.com",
      age: "9".repeat(MAX_FIELD_LENGTH + 1),
    });
    expect(res.ok).toBe(false);
  });

  it("rejects a non-object body", () => {
    expect(validateSubmission(FIELDS, "nope").ok).toBe(false);
    expect(validateSubmission(FIELDS, [1, 2]).ok).toBe(false);
    expect(validateSubmission(FIELDS, null).ok).toBe(false);
  });

  it("rejects a non-string value for a text field (object injection)", () => {
    const res = validateSubmission(FIELDS, {
      email: "a@b.com",
      name: { $ne: null },
    });
    expect(res).toEqual({ ok: false, error: expect.stringMatching(/text/) });
  });
});

/**
 * Branding is re-projected + re-validated on read (`projectBranding`), not trusted from the graph row.
 * The save gate (`CONFIG_SCHEMAS.formTrigger`) already rejects a bad `accentColor`/`redirectUrl`, so
 * every case below models a row that did NOT pass through it — a direct DB write, a restored backup,
 * or a row written before the constraint existed. This is the LAST gate before the value reaches an
 * anonymous browser, where a bad accent is CSS injection and a bad redirect is stored XSS on our own
 * origin, so it has to hold on its own.
 *
 * Policy throughout: DROP the offending key, never repair it. A missing accent falls back to the
 * default ember and a missing redirect falls back to the success card — both correct degradations.
 */
describe("branding is re-validated on read, not trusted", () => {
  const withBranding = (branding: unknown) =>
    extractFormDefinition(formGraph({ fields: FIELDS, branding }), "f1")
      ?.branding;

  it("is absent when the author set none (the page renders exactly as before)", () => {
    expect(
      extractFormDefinition(formGraph({ fields: FIELDS }), "f1")?.branding,
    ).toBeUndefined();
  });

  it("passes through a fully valid block", () => {
    expect(
      withBranding({
        successTitle: "Thanks!",
        successMessage: "We will reply within a day.",
        redirectUrl: "https://acme.test/thanks",
        accentColor: "#3355ff",
        theme: "light",
        desktopColumns: 2,
        width: "wide",
      }),
    ).toEqual({
      successTitle: "Thanks!",
      successMessage: "We will reply within a day.",
      redirectUrl: "https://acme.test/thanks",
      accentColor: "#3355ff",
      theme: "light",
      desktopColumns: 2,
      width: "wide",
    });
  });

  /** The CSS-injection shapes. Anything but a literal #rrggbb is dropped. */
  it.each([
    "red",
    "#fff",
    "#GGGGGG",
    "rgb(1,2,3)",
    "#3355ff; background: url(https://evil.example/x)",
    "#3355ff) url(https://evil.example/x",
    "var(--x)",
    " #3355ff",
    42,
    null,
    { nested: true },
  ])("drops accentColor %s", (accentColor) => {
    expect(withBranding({ accentColor })?.accentColor).toBeUndefined();
  });

  /**
   * `javascript:`/`data:` here would be stored XSS runnable by anyone with the public form link;
   * `http:` would downgrade a visitor who just submitted over TLS; credentials in the authority make
   * the URL read as one site while resolving to another, and we SHOW this target to the visitor.
   */
  it.each([
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "http://acme.test/thanks",
    "//acme.test/thanks",
    "/relative/path",
    "https://trusted.test@evil.example/",
    "https://user:pass@evil.example/",
    "not a url",
    "",
    7,
    null,
  ])("drops redirectUrl %s", (redirectUrl) => {
    expect(withBranding({ redirectUrl })?.redirectUrl).toBeUndefined();
  });

  it("keeps an https redirect with a path, query and fragment", () => {
    const url = "https://acme.test/thanks?ref=form#top";
    expect(withBranding({ redirectUrl: url })?.redirectUrl).toBe(url);
  });

  it("drops an over-long redirect rather than serving it", () => {
    const long = `https://acme.test/${"x".repeat(2_100)}`;
    expect(withBranding({ redirectUrl: long })?.redirectUrl).toBeUndefined();
  });

  it.each(["auto", "light", "dark"])("keeps theme %s", (theme) => {
    expect(withBranding({ theme })?.theme).toBe(theme);
  });

  it.each(["solarized", "", true, 1])("drops theme %s", (theme) => {
    expect(withBranding({ theme })?.theme).toBeUndefined();
  });

  it("accepts only 1 or 2 columns", () => {
    expect(withBranding({ desktopColumns: 1 })?.desktopColumns).toBe(1);
    expect(withBranding({ desktopColumns: 2 })?.desktopColumns).toBe(2);
    for (const bad of [0, 3, "2", 2.5, null]) {
      expect(withBranding({ desktopColumns: bad })?.desktopColumns).toBeUndefined();
    }
  });

  it("accepts only the two widths", () => {
    expect(withBranding({ width: "wide" })?.width).toBe("wide");
    expect(withBranding({ width: "narrow" })?.width).toBe("narrow");
    expect(withBranding({ width: "full" })?.width).toBeUndefined();
  });

  /** One bad key must not discard the author's other, valid settings. */
  it("drops only the offending key", () => {
    expect(
      withBranding({
        successTitle: "Thanks!",
        accentColor: "url(https://evil.example/x)",
        redirectUrl: "javascript:alert(1)",
        width: "wide",
      }),
    ).toEqual({ successTitle: "Thanks!", width: "wide" });
  });

  /** No unexpected authoring key rides out to the anonymous browser. */
  it("never echoes an unknown key", () => {
    // JSON.parse, not an object literal: `__proto__:` in a literal is special-cased by the spec and
    // sets the prototype instead of creating an own key, so a literal would test nothing here.
    const out = withBranding(
      JSON.parse(
        String.raw`{"successTitle":"Thanks!","internalNote":"do not ship","__proto__":{"polluted":true}}`,
      ),
    ) as Record<string, unknown>;
    expect(Object.keys(out)).toEqual(["successTitle"]);
  });

  it("is absent (not an empty object) when nothing survives", () => {
    expect(withBranding({ accentColor: "red", theme: "neon" })).toBeUndefined();
    expect(withBranding({})).toBeUndefined();
    expect(withBranding(null)).toBeUndefined();
    expect(withBranding("a string")).toBeUndefined();
    expect(withBranding([])).toBeUndefined();
  });

  it("ignores whitespace-only copy rather than rendering an empty heading", () => {
    expect(
      withBranding({ successTitle: "   ", successMessage: "\n\t" }),
    ).toBeUndefined();
  });
});
