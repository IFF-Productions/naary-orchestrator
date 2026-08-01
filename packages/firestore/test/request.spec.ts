import { describe, expect, it } from "vitest";
import {
  FirestoreRequestError,
  buildQueryRequest,
  buildWriteRequest,
  parseDocument,
  parseListResponse,
  parseRunQueryResponse,
} from "../src/request";
import { FirestorePathError } from "../src/path";
import {
  FirestoreEmulatorError,
  isEmulatorBase,
  resolveEmulatorBaseUrl,
} from "../src/emulator";

const TARGET = { projectId: "proj", collection: "users" };

describe("buildQueryRequest", () => {
  it("builds a get", () => {
    expect(
      buildQueryRequest({ ...TARGET, action: "get", documentId: "ada" }),
    ).toEqual({
      method: "GET",
      url: "https://firestore.googleapis.com/v1/projects/proj/databases/(default)/documents/users/ada",
    });
  });

  it("builds a list with the default page size", () => {
    const req = buildQueryRequest({ ...TARGET, action: "list" });
    expect(req.method).toBe("GET");
    expect(req.url).toContain("/documents/users?");
    expect(req.url).toContain("pageSize=100");
  });

  it("clamps the list page size to the maximum", () => {
    expect(
      buildQueryRequest({ ...TARGET, action: "list", limit: 99999 }).url,
    ).toContain("pageSize=1000");
    expect(
      buildQueryRequest({ ...TARGET, action: "list", limit: 0 }).url,
    ).toContain("pageSize=1");
  });

  it("carries a page token", () => {
    expect(
      buildQueryRequest({ ...TARGET, action: "list" }, undefined, "tok").url,
    ).toContain("pageToken=tok");
  });

  it("builds a structured query against the collection's parent", () => {
    const req = buildQueryRequest({
      ...TARGET,
      action: "query",
      filters: [{ field: "age", op: ">=", value: 18 }],
      orderBy: [{ field: "name", direction: "desc" }],
      limit: 5,
    });
    expect(req.method).toBe("POST");
    expect(req.url).toBe(
      "https://firestore.googleapis.com/v1/projects/proj/databases/(default)/documents:runQuery",
    );
    expect(req.body).toEqual({
      structuredQuery: {
        from: [{ collectionId: "users" }],
        where: {
          fieldFilter: {
            field: { fieldPath: "age" },
            op: "GREATER_THAN_OR_EQUAL",
            // The filter value goes through the same codec — an integer is a STRING.
            value: { integerValue: "18" },
          },
        },
        orderBy: [{ field: { fieldPath: "name" }, direction: "DESCENDING" }],
        limit: 5,
      },
    });
  });

  it("ANDs multiple filters into a composite", () => {
    const req = buildQueryRequest({
      ...TARGET,
      action: "query",
      filters: [
        { field: "a", op: "==", value: 1 },
        { field: "b", op: "<", value: "z" },
      ],
    });
    const q = (
      req.body as { structuredQuery: { where: { compositeFilter?: unknown } } }
    ).structuredQuery;
    expect(q.where.compositeFilter).toBeDefined();
  });

  it("uses the UNARY filter form for null — a fieldFilter against null is rejected by Firestore", () => {
    const req = buildQueryRequest({
      ...TARGET,
      action: "query",
      filters: [{ field: "deletedAt", op: "==", value: null }],
    });
    const q = (req.body as { structuredQuery: { where: unknown } })
      .structuredQuery;
    expect(q.where).toEqual({
      unaryFilter: { field: { fieldPath: "deletedAt" }, op: "IS_NULL" },
    });
  });

  it("rejects a null comparison the API cannot express", () => {
    expect(() =>
      buildQueryRequest({
        ...TARGET,
        action: "query",
        filters: [{ field: "a", op: "<", value: null }],
      }),
    ).toThrow(/cannot compare against null/);
  });

  it("rejects an unknown operator", () => {
    expect(() =>
      buildQueryRequest({
        ...TARGET,
        action: "query",
        filters: [{ field: "a", op: "~=", value: 1 }],
      }),
    ).toThrow(/Unsupported filter operator/);
  });

  it("rejects an unknown action", () => {
    expect(() =>
      buildQueryRequest({ ...TARGET, action: "drop" as "get" }),
    ).toThrow(FirestoreRequestError);
  });

  it("refuses an injected documentId before any request is built", () => {
    expect(() =>
      buildQueryRequest({
        ...TARGET,
        action: "get",
        documentId: "../../admin",
      }),
    ).toThrow(FirestorePathError);
  });
});

describe("buildWriteRequest", () => {
  it("set is a PATCH with NO updateMask — create-or-replace", () => {
    const req = buildWriteRequest({
      ...TARGET,
      action: "set",
      documentId: "ada",
      data: { name: "Ada", count: 5 },
    });
    expect(req.method).toBe("PATCH");
    expect(req.url).not.toContain("updateMask");
    expect(req.body).toEqual({
      fields: { name: { stringValue: "Ada" }, count: { integerValue: "5" } },
    });
  });

  it("update sends an updateMask derived from the data keys", () => {
    // Without the mask Firestore would DELETE every unlisted field — same call, totally
    // different outcome.
    const req = buildWriteRequest({
      ...TARGET,
      action: "update",
      documentId: "ada",
      data: { name: "Ada" },
    });
    expect(req.method).toBe("PATCH");
    expect(req.url).toContain("updateMask.fieldPaths=name");
  });

  it("update honours an explicit mask", () => {
    const req = buildWriteRequest({
      ...TARGET,
      action: "update",
      documentId: "ada",
      data: { a: 1 },
      updateMask: ["a", "b.c"],
    });
    expect(req.url).toContain("updateMask.fieldPaths=a");
    expect(req.url).toContain("updateMask.fieldPaths=b.c");
  });

  it("refuses an empty update rather than silently clearing the document", () => {
    expect(() =>
      buildWriteRequest({
        ...TARGET,
        action: "update",
        documentId: "ada",
        data: {},
      }),
    ).toThrow(/would clear the document/);
  });

  it("create POSTs to the collection, with an optional client-chosen id", () => {
    const auto = buildWriteRequest({
      ...TARGET,
      action: "create",
      data: { a: 1 },
    });
    expect(auto.method).toBe("POST");
    expect(auto.url).toMatch(/\/documents\/users$/);

    const chosen = buildWriteRequest({
      ...TARGET,
      action: "create",
      documentId: "ada",
      data: { a: 1 },
    });
    expect(chosen.url).toContain("documentId=ada");
  });

  it("delete is a DELETE on the document", () => {
    expect(
      buildWriteRequest({ ...TARGET, action: "delete", documentId: "ada" }),
    ).toEqual({
      method: "DELETE",
      url: "https://firestore.googleapis.com/v1/projects/proj/databases/(default)/documents/users/ada",
    });
  });

  it("rejects non-object document data", () => {
    expect(() =>
      buildWriteRequest({
        ...TARGET,
        action: "set",
        documentId: "a",
        data: [1] as unknown as Record<string, unknown>,
      }),
    ).toThrow(/must be an object/);
  });

  it("honours typedValues when encoding the document", () => {
    const req = buildWriteRequest({
      ...TARGET,
      action: "set",
      documentId: "ada",
      data: { score: { doubleValue: 1 } },
      typedValues: true,
    });
    expect(req.body).toEqual({ fields: { score: { doubleValue: 1 } } });
  });
});

describe("response parsing", () => {
  const raw = {
    name: "projects/proj/databases/(default)/documents/users/ada",
    fields: { name: { stringValue: "Ada" }, count: { integerValue: "5" } },
    createTime: "2026-01-01T00:00:00Z",
    updateTime: "2026-01-02T00:00:00Z",
  };

  it("decodes a document into plain JSON with its id", () => {
    expect(parseDocument(raw)).toEqual({
      id: "ada",
      name: raw.name,
      data: { name: "Ada", count: 5 },
      createTime: "2026-01-01T00:00:00Z",
      updateTime: "2026-01-02T00:00:00Z",
    });
  });

  it("percent-decodes the id back to what the author wrote", () => {
    expect(
      parseDocument({
        name: "projects/p/databases/(default)/documents/u/a%20b",
      }).id,
    ).toBe("a b");
  });

  it("survives a malformed escape in the resource name", () => {
    expect(
      parseDocument({ name: "projects/p/databases/(default)/documents/u/100%" })
        .id,
    ).toBe("100%");
  });

  it("skips runQuery entries with no document (skipped results)", () => {
    expect(
      parseRunQueryResponse([
        { readTime: "t", skippedResults: 3 },
        { document: raw },
      ]),
    ).toHaveLength(1);
    expect(parseRunQueryResponse(null)).toEqual([]);
  });

  it("reads a list page and its continuation token", () => {
    expect(
      parseListResponse({ documents: [raw], nextPageToken: "tok" }),
    ).toEqual({
      documents: [parseDocument(raw)],
      nextPageToken: "tok",
    });
    expect(parseListResponse({})).toEqual({ documents: [] });
  });
});

describe("emulator base URL", () => {
  it("is off when unset or blank", () => {
    expect(resolveEmulatorBaseUrl(undefined)).toBeNull();
    expect(resolveEmulatorBaseUrl("")).toBeNull();
    expect(resolveEmulatorBaseUrl("   ")).toBeNull();
  });

  it("accepts loopback hosts", () => {
    expect(resolveEmulatorBaseUrl("127.0.0.1:8080")).toBe(
      "http://127.0.0.1:8080",
    );
    expect(resolveEmulatorBaseUrl("localhost:8080")).toBe(
      "http://localhost:8080",
    );
    expect(resolveEmulatorBaseUrl("http://127.0.0.1:8080/")).toBe(
      "http://127.0.0.1:8080",
    );
  });

  it("REFUSES a non-loopback host — this is what stops it redirecting production", () => {
    expect(() => resolveEmulatorBaseUrl("evil.example.com:8080")).toThrow(
      FirestoreEmulatorError,
    );
    expect(() => resolveEmulatorBaseUrl("10.0.0.5:8080")).toThrow(/loopback/);
    expect(() => resolveEmulatorBaseUrl("169.254.169.254:80")).toThrow(
      /loopback/,
    );
    // It throws rather than falling back to production: a worker aimed at a non-local
    // emulator is misconfigured, and silently shipping documents to Google instead
    // would be the worse surprise.
    expect(() => resolveEmulatorBaseUrl("firestore.googleapis.com")).toThrow(
      /loopback/,
    );
  });

  it("builds a request against the emulator base", () => {
    const base = resolveEmulatorBaseUrl("127.0.0.1:8080") as string;
    expect(isEmulatorBase(base)).toBe(true);
    expect(isEmulatorBase("https://firestore.googleapis.com")).toBe(false);
    expect(
      buildQueryRequest({ ...TARGET, action: "get", documentId: "ada" }, base)
        .url,
    ).toBe(
      "http://127.0.0.1:8080/v1/projects/proj/databases/(default)/documents/users/ada",
    );
  });
});
