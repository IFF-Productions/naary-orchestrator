import { useState } from "react";
import {
  type FieldType,
  type JsonSchemaObject,
  type PrimitiveType,
  type SchemaField,
  fieldsToJsonSchema,
  jsonSchemaToFields,
} from "../../lib/schema-fields";

/**
 * Friendly add/remove field editor for an agent node's structured-output schema —
 * replaces hand-writing JSON Schema. Edits a field list (name + type + required,
 * with enum options / array item-type / nested object fields) and emits the
 * compiled JSON Schema object. Conversion logic lives in lib/schema-fields (pure,
 * tested); this is just the UI. Recursive for `object` fields.
 */
const inputStyle: React.CSSProperties = {
  padding: "5px 7px",
  borderRadius: 6,
  border: "1px solid var(--line-2)",
  background: "var(--card)",
  color: "var(--ink)",
  fontSize: 12,
};

const TYPES: FieldType[] = [
  "string",
  "number",
  "boolean",
  "enum",
  "array",
  "object",
];

export function SchemaEditor({
  schema,
  onChange,
}: {
  schema?: JsonSchemaObject;
  onChange: (schema: JsonSchemaObject | undefined) => void;
}) {
  const [fields, setFields] = useState<SchemaField[]>(() =>
    jsonSchemaToFields(schema),
  );
  function update(next: SchemaField[]): void {
    setFields(next);
    onChange(next.length ? fieldsToJsonSchema(next) : undefined);
  }
  return <FieldList fields={fields} onChange={update} />;
}

function FieldList({
  fields,
  onChange,
}: {
  fields: SchemaField[];
  onChange: (fields: SchemaField[]) => void;
}) {
  const set = (i: number, f: SchemaField) =>
    onChange(fields.map((x, j) => (j === i ? f : x)));
  const remove = (i: number) => onChange(fields.filter((_, j) => j !== i));
  const add = () =>
    onChange([...fields, { name: "", type: "string", required: false }]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
      {fields.map((f, i) => (
        <FieldRow
          // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional; names are editable/duplicable
          key={i}
          field={f}
          onChange={(nf) => set(i, nf)}
          onRemove={() => remove(i)}
        />
      ))}
      <button
        type="button"
        onClick={add}
        style={{
          border: "1px dashed var(--line-2)",
          background: "transparent",
          color: "var(--ink-2)",
          borderRadius: 7,
          padding: "6px 8px",
          fontSize: 11.5,
          cursor: "pointer",
        }}
      >
        + Add field
      </button>
    </div>
  );
}

function FieldRow({
  field,
  onChange,
  onRemove,
}: {
  field: SchemaField;
  onChange: (f: SchemaField) => void;
  onRemove: () => void;
}) {
  return (
    <div
      style={{
        border: "1px solid var(--line)",
        borderRadius: 8,
        padding: 7,
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <input
          value={field.name}
          onChange={(e) => onChange({ ...field, name: e.target.value })}
          placeholder="field name"
          style={{ ...inputStyle, flex: 1 }}
        />
        <select
          value={field.type}
          onChange={(e) =>
            onChange({ ...field, type: e.target.value as FieldType })
          }
          style={inputStyle}
        >
          {TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 3,
            fontSize: 11,
            color: "var(--ink-2)",
          }}
          title="Required"
        >
          <input
            type="checkbox"
            checked={field.required}
            onChange={(e) => onChange({ ...field, required: e.target.checked })}
          />
          req
        </label>
        <button
          type="button"
          aria-label="Remove field"
          onClick={onRemove}
          style={{
            border: "1px solid var(--line-2)",
            background: "var(--card)",
            color: "var(--ink-3)",
            borderRadius: 6,
            cursor: "pointer",
            padding: "0 8px",
          }}
        >
          ✕
        </button>
      </div>

      {field.type === "enum" && (
        <input
          value={(field.enumOptions ?? []).join(", ")}
          onChange={(e) =>
            onChange({
              ...field,
              enumOptions: e.target.value
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean),
            })
          }
          placeholder="options, comma-separated"
          style={inputStyle}
        />
      )}

      {field.type === "array" && (
        <select
          value={field.itemType ?? "string"}
          onChange={(e) =>
            onChange({ ...field, itemType: e.target.value as PrimitiveType })
          }
          style={inputStyle}
        >
          <option value="string">array of string</option>
          <option value="number">array of number</option>
          <option value="boolean">array of boolean</option>
        </select>
      )}

      {field.type === "object" && (
        <div
          style={{
            marginLeft: 8,
            paddingLeft: 8,
            borderLeft: "2px solid var(--line-2)",
          }}
        >
          <FieldList
            fields={field.fields ?? []}
            onChange={(nf) => onChange({ ...field, fields: nf })}
          />
        </div>
      )}
    </div>
  );
}
