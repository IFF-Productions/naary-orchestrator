import { describe, expect, it } from "vitest";
import {
  FirestorePathError,
  collectionPath,
  documentPath,
  documentsRoot,
  encodeCollectionPath,
  encodeSegment,
  queryParent,
} from "../src/path";

/**
 * Path-segment injection is the real security hole in a Firestore node: `projectId`,
 * `databaseId`, `collection` and `documentId` are all author-supplied and all land in the
 * URL path. This is the analogue of the sqlQuery node's "the SQL text is STATIC".
 */

describe("encodeSegment — injection guard", () => {
  it("rejects a segment containing a slash — the path-escape attack", () => {
    // Without this, documentId `ada/../../admin` addresses a DIFFERENT document.
    expect(() => encodeSegment("documentId", "ada/orders")).toThrow(
      FirestorePathError,
    );
    expect(() => encodeSegment("documentId", "../admin")).toThrow(
      /may not contain "\/"/,
    );
    expect(() => encodeSegment("documentId", "a/../../b")).toThrow(
      FirestorePathError,
    );
  });

  it("rejects the traversal segments themselves", () => {
    expect(() => encodeSegment("documentId", ".")).toThrow(
      /may not be "\." or "\.\."/,
    );
    expect(() => encodeSegment("documentId", "..")).toThrow(FirestorePathError);
  });

  it("rejects empty / missing / non-string", () => {
    expect(() => encodeSegment("documentId", "")).toThrow(/is required/);
    expect(() => encodeSegment("documentId", undefined)).toThrow(/is required/);
    expect(() => encodeSegment("documentId", 5)).toThrow(/is required/);
  });

  it("rejects control characters", () => {
    expect(() => encodeSegment("documentId", "a\u0000b")).toThrow(
      /control characters/,
    );
    expect(() => encodeSegment("documentId", "a\u001fb")).toThrow(
      /control characters/,
    );
    expect(() => encodeSegment("documentId", "a\u007fb")).toThrow(
      /control characters/,
    );
  });

  it("rejects Firestore's reserved __*__ form", () => {
    expect(() => encodeSegment("documentId", "__name__")).toThrow(
      /reserves that form/,
    );
  });

  it("rejects a segment over Firestore's 1500-byte limit", () => {
    expect(() => encodeSegment("documentId", "a".repeat(1501))).toThrow(
      /1500-byte/,
    );
    expect(encodeSegment("documentId", "a".repeat(1500))).toHaveLength(1500);
  });

  it("percent-encodes the query/fragment characters so they cannot restructure the URL", () => {
    // Even if one slipped past validation, encoding means it cannot inject a query param.
    expect(encodeSegment("documentId", "a?b")).toBe("a%3Fb");
    expect(encodeSegment("documentId", "a#b")).toBe("a%23b");
    expect(encodeSegment("documentId", "a&b=c")).toBe("a%26b%3Dc");
    expect(encodeSegment("documentId", "a b")).toBe("a%20b");
    expect(encodeSegment("documentId", "100%")).toBe("100%25");
  });

  it("passes ordinary ids through unchanged", () => {
    expect(encodeSegment("documentId", "ada")).toBe("ada");
    expect(encodeSegment("documentId", "user-123_abc")).toBe("user-123_abc");
  });
});

describe("encodeCollectionPath", () => {
  it("accepts a top-level collection and a subcollection", () => {
    expect(encodeCollectionPath("users")).toBe("users");
    expect(encodeCollectionPath("users/ada/orders")).toBe("users/ada/orders");
  });

  it("rejects an even segment count — that names a document, not a collection", () => {
    expect(() => encodeCollectionPath("users/ada")).toThrow(/names a document/);
  });

  it("validates every segment of a subcollection path", () => {
    expect(() => encodeCollectionPath("users//orders")).toThrow(/is required/);
    expect(() => encodeCollectionPath("users/../orders")).toThrow(
      /"\." or "\.\."/,
    );
  });

  it("encodes each segment independently", () => {
    expect(encodeCollectionPath("us ers/a da/or ders")).toBe(
      "us%20ers/a%20da/or%20ders",
    );
  });
});

describe("resource paths", () => {
  it("defaults databaseId to (default) and encodes its parentheses", () => {
    expect(documentsRoot("proj")).toBe(
      "projects/proj/databases/(default)/documents",
    );
  });

  it("builds a collection and a document path", () => {
    expect(collectionPath({ projectId: "p", collection: "users" })).toBe(
      "projects/p/databases/(default)/documents/users",
    );
    expect(
      documentPath({ projectId: "p", collection: "users", documentId: "ada" }),
    ).toBe("projects/p/databases/(default)/documents/users/ada");
  });

  it("honours a non-default databaseId", () => {
    expect(
      collectionPath({ projectId: "p", databaseId: "eu", collection: "users" }),
    ).toBe("projects/p/databases/eu/documents/users");
  });

  it("refuses a document path with no documentId", () => {
    expect(() => documentPath({ projectId: "p", collection: "users" })).toThrow(
      /documentId is required/,
    );
  });

  it("refuses an injected projectId", () => {
    expect(() => documentsRoot("p/../../other")).toThrow(FirestorePathError);
  });
});

describe("queryParent", () => {
  it("splits a top-level collection into the documents root + collection id", () => {
    expect(queryParent({ projectId: "p", collection: "users" })).toEqual({
      parent: "projects/p/databases/(default)/documents",
      collectionId: "users",
    });
  });

  it("splits a subcollection into its parent document + leaf collection id", () => {
    expect(
      queryParent({ projectId: "p", collection: "users/ada/orders" }),
    ).toEqual({
      parent: "projects/p/databases/(default)/documents/users/ada",
      collectionId: "orders",
    });
  });

  it("leaves collectionId UN-encoded — it rides in the JSON body, not the URL", () => {
    // Percent-encoding here would silently query a different, nonexistent collection.
    const { parent, collectionId } = queryParent({
      projectId: "p",
      collection: "us ers/a da/or ders",
    });
    expect(collectionId).toBe("or ders");
    expect(parent).toBe(
      "projects/p/databases/(default)/documents/us%20ers/a%20da",
    );
  });

  it("still validates every segment", () => {
    expect(() =>
      queryParent({ projectId: "p", collection: "users/../orders" }),
    ).toThrow(FirestorePathError);
  });
});
