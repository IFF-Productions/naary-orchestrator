/**
 * Authoring-time introspection parsers (roadmap: HTTP OpenAPI/Swagger + GraphQL autocomplete). These
 * are PURE (no network, no secrets) — the API controller fetches the spec through the SSRF-guarded
 * safeFetch and hands the raw payload here. Kept dep-free and defensive: every input is untrusted
 * (an arbitrary remote spec), so each accessor tolerates missing/mistyped fields and never throws.
 */

// ---- OpenAPI / Swagger --------------------------------------------------------------------------

/** One operation (method + path) discovered in an OpenAPI/Swagger spec — enough to autocomplete an
 *  httpRequest node's method + URL + params. */
export interface ApiOperation {
  method: string; // upper-case: GET/POST/PUT/PATCH/DELETE
  path: string; // e.g. "/users/{id}"
  operationId?: string;
  summary?: string;
  /** Parameters by location — `in` is path | query | header. */
  parameters: { name: string; in: string; required: boolean }[];
  /** Whether the operation declares a request body (Swagger 2 `body` param / OpenAPI 3 requestBody). */
  hasBody: boolean;
}

export interface OpenApiSummary {
  title?: string;
  /** Best-effort base URL (OpenAPI 3 `servers[0].url`, or Swagger 2 scheme+host+basePath). */
  baseUrl?: string;
  operations: ApiOperation[];
}

const HTTP_METHODS = ["get", "put", "post", "delete", "patch"] as const;

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}
function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** Derive the base URL: OpenAPI 3 `servers[0].url`, else Swagger 2 `scheme://host+basePath`. */
function openApiBaseUrl(spec: Record<string, unknown>): string | undefined {
  const servers = asArray(spec.servers);
  const first = asRecord(servers[0]);
  const serverUrl = asString(first.url);
  if (serverUrl) return serverUrl;
  const host = asString(spec.host);
  if (host) {
    const schemes = asArray(spec.schemes).filter(
      (s): s is string => typeof s === "string",
    );
    const scheme = schemes.includes("https")
      ? "https"
      : (schemes[0] ?? "https");
    const basePath = asString(spec.basePath) ?? "";
    return `${scheme}://${host}${basePath}`;
  }
  return undefined;
}

/**
 * Parse an OpenAPI 3.x or Swagger 2.0 spec (already JSON-decoded) into a flat operation list. Walks
 * `paths[path][method]`, collecting parameters (path-level params merge into each operation) and
 * whether a body is declared. Unknown/oddly-shaped entries are skipped, never thrown on.
 */
export function parseOpenApi(spec: unknown): OpenApiSummary {
  const root = asRecord(spec);
  const info = asRecord(root.info);
  const paths = asRecord(root.paths);
  const operations: ApiOperation[] = [];

  const readParams = (
    raw: unknown,
  ): { name: string; in: string; required: boolean }[] =>
    asArray(raw)
      .map((p) => {
        const rec = asRecord(p);
        const name = asString(rec.name);
        const location = asString(rec.in);
        if (!name || !location) return null;
        return { name, in: location, required: rec.required === true };
      })
      .filter((p): p is { name: string; in: string; required: boolean } => !!p);

  for (const [path, pathItemRaw] of Object.entries(paths)) {
    const pathItem = asRecord(pathItemRaw);
    const pathLevelParams = readParams(pathItem.parameters);
    for (const method of HTTP_METHODS) {
      const opRaw = pathItem[method];
      if (!opRaw || typeof opRaw !== "object") continue;
      const op = asRecord(opRaw);
      const opParams = readParams(op.parameters);
      // Swagger 2 body is a param with in:"body"; OpenAPI 3 has a top-level requestBody.
      const hasBody =
        op.requestBody != null ||
        [...pathLevelParams, ...opParams].some((p) => p.in === "body");
      operations.push({
        method: method.toUpperCase(),
        path,
        operationId: asString(op.operationId),
        summary: asString(op.summary) ?? asString(op.description),
        // Merge path-level + operation params; drop the synthetic body param from the list.
        parameters: [...pathLevelParams, ...opParams].filter(
          (p) => p.in !== "body",
        ),
        hasBody,
      });
    }
  }
  return {
    title: asString(info.title),
    baseUrl: openApiBaseUrl(root),
    operations,
  };
}

// ---- GraphQL introspection ----------------------------------------------------------------------

/** The standard GraphQL introspection query, trimmed to the fields we surface for autocomplete
 *  (type + field + arg names). Sent by the API to the endpoint; the result is parsed below. */
export const GRAPHQL_INTROSPECTION_QUERY = `query IntrospectionQuery {
  __schema {
    queryType { name }
    mutationType { name }
    types {
      name
      kind
      fields { name args { name } type { name kind ofType { name kind ofType { name kind } } } }
    }
  }
}`;

export interface GraphQLField {
  name: string;
  args: string[];
  /** Best-effort readable type name (unwraps NON_NULL / LIST one or two levels). */
  type?: string;
}
export interface GraphQLTypeSummary {
  name: string;
  kind: string;
  fields: GraphQLField[];
}
export interface GraphQLSchemaSummary {
  queryType?: string;
  mutationType?: string;
  types: GraphQLTypeSummary[];
}

/** Unwrap a GraphQL type ref (NON_NULL/LIST wrappers) to a readable named type. */
function typeName(v: unknown): string | undefined {
  let cur = asRecord(v);
  for (let i = 0; i < 4 && cur; i++) {
    const name = asString(cur.name);
    if (name) return name;
    cur = asRecord(cur.ofType);
  }
  return undefined;
}

/**
 * Parse an introspection response's `data` (or the whole response) into a compact schema summary.
 * Skips the built-in `__`-prefixed introspection types. Defensive against partial/odd payloads.
 */
export function parseIntrospection(data: unknown): GraphQLSchemaSummary {
  const root = asRecord(data);
  // Accept either the raw `{ data: { __schema } }` or an already-unwrapped `{ __schema }`.
  const schema = asRecord(asRecord(root.data).__schema ?? root.__schema);
  const types: GraphQLTypeSummary[] = asArray(schema.types)
    .map((t) => {
      const rec = asRecord(t);
      const name = asString(rec.name);
      if (!name || name.startsWith("__")) return null;
      const fields: GraphQLField[] = asArray(rec.fields)
        .map((f): GraphQLField | null => {
          const fr = asRecord(f);
          const fname = asString(fr.name);
          if (!fname) return null;
          return {
            name: fname,
            args: asArray(fr.args)
              .map((a) => asString(asRecord(a).name))
              .filter((a): a is string => !!a),
            type: typeName(fr.type),
          };
        })
        .filter((f): f is GraphQLField => f !== null);
      return { name, kind: asString(rec.kind) ?? "OBJECT", fields };
    })
    .filter((t): t is GraphQLTypeSummary => !!t);
  return {
    queryType: asString(asRecord(schema.queryType).name),
    mutationType: asString(asRecord(schema.mutationType).name),
    types,
  };
}
