import { describe, expect, it } from "vitest";
import {
  type SchemaField,
  fieldsToJsonSchema,
  jsonSchemaToFields,
} from "../src/lib/schema-fields";

describe("fieldsToJsonSchema", () => {
  it("compiles primitives + required", () => {
    const fields: SchemaField[] = [
      { name: "category", type: "string", required: true },
      { name: "confidence", type: "number", required: false },
      { name: "flagged", type: "boolean", required: true },
    ];
    expect(fieldsToJsonSchema(fields)).toEqual({
      type: "object",
      properties: {
        category: { type: "string" },
        confidence: { type: "number" },
        flagged: { type: "boolean" },
      },
      required: ["category", "flagged"],
      additionalProperties: false,
    });
  });

  it("compiles enum, array, and nested object", () => {
    const fields: SchemaField[] = [
      { name: "kind", type: "enum", required: true, enumOptions: ["a", "b"] },
      { name: "tags", type: "array", required: false, itemType: "string" },
      {
        name: "meta",
        type: "object",
        required: false,
        fields: [{ name: "score", type: "number", required: true }],
      },
    ];
    const schema = fieldsToJsonSchema(fields);
    expect(schema.properties.kind).toEqual({
      type: "string",
      enum: ["a", "b"],
    });
    expect(schema.properties.tags).toEqual({
      type: "array",
      items: { type: "string" },
    });
    expect(schema.properties.meta).toEqual({
      type: "object",
      properties: { score: { type: "number" } },
      required: ["score"],
      additionalProperties: false,
    });
  });

  it("skips unnamed fields", () => {
    const schema = fieldsToJsonSchema([
      { name: "  ", type: "string", required: false },
      { name: "ok", type: "string", required: false },
    ]);
    expect(Object.keys(schema.properties)).toEqual(["ok"]);
  });
});

describe("round-trip (fields → schema → fields)", () => {
  it("recovers the field list", () => {
    const fields: SchemaField[] = [
      {
        name: "category",
        type: "enum",
        required: true,
        enumOptions: ["x", "y"],
      },
      { name: "tags", type: "array", required: false, itemType: "number" },
      {
        name: "meta",
        type: "object",
        required: false,
        fields: [{ name: "n", type: "boolean", required: true }],
      },
      { name: "note", type: "string", required: false },
    ];
    expect(jsonSchemaToFields(fieldsToJsonSchema(fields))).toEqual(fields);
  });

  it("returns [] for empty/undefined schema", () => {
    expect(jsonSchemaToFields(undefined)).toEqual([]);
  });
});
