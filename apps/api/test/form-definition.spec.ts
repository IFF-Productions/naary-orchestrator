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
