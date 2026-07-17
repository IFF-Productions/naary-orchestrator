import { describe, expect, it } from "vitest";
import { parseIntrospection, parseOpenApi } from "../src/introspection";

describe("parseOpenApi — OpenAPI 3.x", () => {
  const spec = {
    openapi: "3.0.0",
    info: { title: "Petstore" },
    servers: [{ url: "https://api.petstore.io/v2" }],
    paths: {
      "/pets/{id}": {
        parameters: [{ name: "id", in: "path", required: true }],
        get: {
          operationId: "getPet",
          summary: "Get a pet",
          parameters: [{ name: "fields", in: "query" }],
        },
        delete: { summary: "Delete a pet" },
      },
      "/pets": {
        post: {
          summary: "Create a pet",
          requestBody: { content: { "application/json": {} } },
        },
      },
    },
  };

  it("extracts baseUrl from servers[0] and walks paths×methods", () => {
    const out = parseOpenApi(spec);
    expect(out.title).toBe("Petstore");
    expect(out.baseUrl).toBe("https://api.petstore.io/v2");
    expect(out.operations.map((o) => `${o.method} ${o.path}`).sort()).toEqual([
      "DELETE /pets/{id}",
      "GET /pets/{id}",
      "POST /pets",
    ]);
  });

  it("merges path-level params into each operation and flags bodies", () => {
    const out = parseOpenApi(spec);
    const get = out.operations.find((o) => o.operationId === "getPet");
    // path-level `id` + operation-level `fields`
    expect(get?.parameters).toEqual([
      { name: "id", in: "path", required: true },
      { name: "fields", in: "query", required: false },
    ]);
    expect(get?.hasBody).toBe(false);
    const post = out.operations.find((o) => o.method === "POST");
    expect(post?.hasBody).toBe(true); // requestBody present
  });
});

describe("parseOpenApi — Swagger 2.0", () => {
  it("derives baseUrl from scheme+host+basePath and treats in:body as a body", () => {
    const out = parseOpenApi({
      swagger: "2.0",
      host: "api.example.com",
      basePath: "/v1",
      schemes: ["http", "https"],
      paths: {
        "/things": {
          post: {
            summary: "Create",
            parameters: [
              { name: "payload", in: "body", required: true },
              { name: "dry", in: "query" },
            ],
          },
        },
      },
    });
    expect(out.baseUrl).toBe("https://api.example.com/v1"); // prefers https
    const op = out.operations[0];
    expect(op.hasBody).toBe(true);
    // the synthetic `in:body` param is dropped from the visible params list
    expect(op.parameters).toEqual([
      { name: "dry", in: "query", required: false },
    ]);
  });
});

describe("parseOpenApi — defensive", () => {
  it("returns an empty result for garbage / missing paths (never throws)", () => {
    expect(parseOpenApi(null).operations).toEqual([]);
    expect(parseOpenApi({ paths: "nope" }).operations).toEqual([]);
    expect(parseOpenApi({ paths: { "/x": { get: 5 } } }).operations).toEqual(
      [],
    );
  });
});

describe("parseIntrospection", () => {
  const data = {
    data: {
      __schema: {
        queryType: { name: "Query" },
        mutationType: { name: "Mutation" },
        types: [
          {
            name: "Query",
            kind: "OBJECT",
            fields: [
              {
                name: "user",
                args: [{ name: "id" }],
                type: { kind: "OBJECT", name: "User" },
              },
            ],
          },
          {
            name: "User",
            kind: "OBJECT",
            fields: [
              {
                name: "name",
                args: [],
                type: {
                  kind: "NON_NULL",
                  ofType: { kind: "SCALAR", name: "String" },
                },
              },
            ],
          },
          { name: "__Directive", kind: "OBJECT", fields: [] }, // built-in — skipped
        ],
      },
    },
  };

  it("summarizes query/mutation type names + fields (unwrapping NON_NULL), skipping __ types", () => {
    const s = parseIntrospection(data);
    expect(s.queryType).toBe("Query");
    expect(s.mutationType).toBe("Mutation");
    expect(s.types.map((t) => t.name)).toEqual(["Query", "User"]); // __Directive dropped
    expect(s.types[0].fields).toEqual([
      { name: "user", args: ["id"], type: "User" },
    ]);
    // NON_NULL wrapper unwrapped to the named scalar
    expect(s.types[1].fields[0].type).toBe("String");
  });

  it("accepts an already-unwrapped { __schema } and tolerates garbage", () => {
    expect(parseIntrospection({ __schema: { types: [] } }).types).toEqual([]);
    expect(parseIntrospection(null).types).toEqual([]);
    expect(parseIntrospection({ data: {} }).types).toEqual([]);
  });
});
