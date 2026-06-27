/**
 * Pure conversion between a friendly FIELD list (what the canvas inspector edits)
 * and a JSON Schema object (what the agent node's `outputSchema` stores + the
 * runtime constrains the model to). Keeping it pure makes it unit-testable and
 * keeps the React editor dumb. Unit-tested in test/schema-fields.spec.ts.
 */

export type FieldType =
  "string" | "number" | "boolean" | "enum" | "array" | "object";

/** A primitive an array can hold (kept simple — no array-of-object in the editor). */
export type PrimitiveType = "string" | "number" | "boolean";

export interface SchemaField {
  name: string;
  type: FieldType;
  required: boolean;
  /** enum: the allowed string values. */
  enumOptions?: string[];
  /** array: the item primitive type. */
  itemType?: PrimitiveType;
  /** object: nested fields (recursive). */
  fields?: SchemaField[];
}

/** A minimal JSON Schema object shape we emit/consume. */
export interface JsonSchemaObject {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties: false;
}

function fieldToProp(f: SchemaField): Record<string, unknown> {
  switch (f.type) {
    case "string":
    case "number":
    case "boolean":
      return { type: f.type };
    case "enum":
      return { type: "string", enum: f.enumOptions ?? [] };
    case "array":
      return { type: "array", items: { type: f.itemType ?? "string" } };
    case "object":
      return fieldsToJsonSchema(f.fields ?? []) as unknown as Record<
        string,
        unknown
      >;
  }
}

/** FIELD list → JSON Schema object. Unnamed fields are skipped. */
export function fieldsToJsonSchema(fields: SchemaField[]): JsonSchemaObject {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const f of fields) {
    const name = f.name.trim();
    if (!name) continue;
    properties[name] = fieldToProp(f);
    if (f.required) required.push(name);
  }
  return {
    type: "object",
    properties,
    ...(required.length ? { required } : {}),
    additionalProperties: false,
  };
}

function propToField(
  name: string,
  prop: Record<string, unknown>,
  required: boolean,
): SchemaField {
  if (Array.isArray(prop.enum)) {
    return {
      name,
      type: "enum",
      required,
      enumOptions: prop.enum.map((v) => String(v)),
    };
  }
  if (prop.type === "array") {
    const items = (prop.items ?? {}) as { type?: string };
    const itemType: PrimitiveType =
      items.type === "number" || items.type === "boolean"
        ? items.type
        : "string";
    return { name, type: "array", required, itemType };
  }
  if (prop.type === "object") {
    return {
      name,
      type: "object",
      required,
      fields: jsonSchemaToFields(prop as unknown as JsonSchemaObject),
    };
  }
  const t: FieldType =
    prop.type === "number" || prop.type === "boolean"
      ? (prop.type as FieldType)
      : "string";
  return { name, type: t, required };
}

/** JSON Schema object → FIELD list (inverse of fieldsToJsonSchema, best-effort). */
export function jsonSchemaToFields(
  schema: JsonSchemaObject | undefined,
): SchemaField[] {
  if (!schema || typeof schema !== "object" || !schema.properties) return [];
  const required = new Set(
    Array.isArray(schema.required) ? schema.required : [],
  );
  return Object.entries(schema.properties).map(([name, prop]) =>
    propToField(
      name,
      (prop ?? {}) as Record<string, unknown>,
      required.has(name),
    ),
  );
}
