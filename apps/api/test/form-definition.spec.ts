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
