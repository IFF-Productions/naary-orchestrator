/**
 * Pure helpers for the GraphQL introspection affordance (kept out of the .tsx so they're unit-testable
 * without a DOM). Turn a schema summary into the actionable root fields and scaffold a starter query.
 */
import type { GraphQLSchemaSummary } from "@naary/dsl";

export interface RootField {
  /** Which operation this field belongs to — drives the scaffold keyword. */
  operation: "query" | "mutation";
  name: string;
  args: string[];
  /** Readable return type name (best-effort), for display. */
  type?: string;
}

/**
 * The fields of the schema's query + mutation ROOT types — the operations a user can actually call,
 * each tagged with its operation. Types the schema references but doesn't define are skipped. These
 * are what the UI offers an "Insert" action for (scaffolding a starter query).
 */
export function rootFields(schema: GraphQLSchemaSummary): RootField[] {
  const out: RootField[] = [];
  const add = (
    typeName: string | undefined,
    operation: "query" | "mutation",
  ) => {
    if (!typeName) return;
    const t = schema.types.find((ty) => ty.name === typeName);
    if (!t) return;
    for (const f of t.fields) {
      out.push({ operation, name: f.name, args: f.args, type: f.type });
    }
  };
  add(schema.queryType, "query");
  add(schema.mutationType, "mutation");
  return out;
}

/** Scaffold a minimal starter query for a root field. Args are left for the user to fill in. */
export function scaffoldQuery(
  operation: "query" | "mutation",
  fieldName: string,
): string {
  return `${operation} {\n  ${fieldName}\n}`;
}
