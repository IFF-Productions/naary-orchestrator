import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BlockedEgressError,
  MissingConnectionTokenError,
} from "@naary/connections";
import { __setObjectStore, MemoryObjectStore } from "@naary/storage";
import {
  __firestoreDeps,
  type FirestoreQueryConfig,
  type FirestoreWriteConfig,
  callFirestoreQuery,
  callFirestoreWrite,
} from "../src/temporal/activities";

const META = { tenantId: "t1", executionId: "exec-1", nodeId: "fs" };

const QUERY: FirestoreQueryConfig = {
  connectionId: "fs-1",
  action: "get",
  projectId: "proj",
  collection: "users",
  documentId: "ada",
};

const WRITE: FirestoreWriteConfig = {
  connectionId: "fs-1",
  action: "set",
  projectId: "proj",
  collection: "users",
  documentId: "ada",
  data: { email: "a@b.co", count: 5 },
};

const resolveAuthHeader = vi.fn();
const assertEgressAllowed = vi.fn();
const fetchMock = vi.fn();

/** Build a fetch Response-alike with the given status + JSON body. */
function res(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  };
}

const DOC = {
  name: "projects/proj/databases/(default)/documents/users/ada",
  fields: { email: { stringValue: "a@b.co" }, count: { integerValue: "5" } },
};

const originals = { ...__firestoreDeps };

beforeEach(() => {
  resolveAuthHeader.mockReset();
  assertEgressAllowed.mockReset();
  fetchMock.mockReset();
  resolveAuthHeader.mockResolvedValue({ Authorization: "Bearer ya29.secret" });
  assertEgressAllowed.mockResolvedValue(
    new URL("https://firestore.googleapis.com/"),
  );
  fetchMock.mockResolvedValue(res(200, DOC));
  __firestoreDeps.resolveAuthHeader = resolveAuthHeader as never;
  __firestoreDeps.assertEgressAllowed = assertEgressAllowed as never;
  __firestoreDeps.fetch = fetchMock as never;
  __firestoreDeps.emulatorHost = () => undefined;
  __setObjectStore(new MemoryObjectStore());
});

afterEach(() => {
  Object.assign(__firestoreDeps, originals);
});

describe("callFirestoreQuery", () => {
  it("decodes typed wire values into plain JSON", async () => {
    const out = await callFirestoreQuery(QUERY, null, META);
    expect(out.status).toBe("ok");
    expect(out.count).toBe(1);
    expect(out.truncated).toBe(false);
    expect(out.documents).toEqual([
      {
        id: "ada",
        name: DOC.name,
        // integerValue "5" (a STRING on the wire) comes back as the number 5.
        data: { email: "a@b.co", count: 5 },
      },
    ]);
  });

  it("sends the connection's bearer token and NEVER returns or logs it", async () => {
    const out = await callFirestoreQuery(QUERY, null, META);
    const headers = (
      fetchMock.mock.calls[0]?.[1] as { headers: Record<string, string> }
    ).headers;
    expect(headers.Authorization).toBe("Bearer ya29.secret");
    expect(resolveAuthHeader).toHaveBeenCalledWith("t1", "fs-1");
    // Tier-1 §4: the token must not ride back out of the activity.
    expect(JSON.stringify(out)).not.toContain("ya29");
  });

  it("runs the egress guard before every real call", async () => {
    await callFirestoreQuery(QUERY, null, META);
    expect(assertEgressAllowed).toHaveBeenCalledWith(
      expect.stringContaining("https://firestore.googleapis.com/v1/"),
    );
  });

  it("maps a blocked egress to a NON-retryable failure", async () => {
    assertEgressAllowed.mockRejectedValue(
      new BlockedEgressError("internal address"),
    );
    await expect(callFirestoreQuery(QUERY, null, META)).rejects.toMatchObject({
      type: "EGRESS_BLOCKED",
      nonRetryable: true,
    });
  });

  it("maps a 401/403 to CONNECTION_REAUTH, non-retryable — don't burn retries on a bad key", async () => {
    fetchMock.mockResolvedValue(
      res(403, { error: { status: "PERMISSION_DENIED" } }),
    );
    await expect(callFirestoreQuery(QUERY, null, META)).rejects.toMatchObject({
      type: "CONNECTION_REAUTH",
      nonRetryable: true,
    });
  });

  it("maps 5xx/429 to a RETRYABLE failure", async () => {
    fetchMock.mockResolvedValue(res(503, { error: { status: "UNAVAILABLE" } }));
    await expect(callFirestoreQuery(QUERY, null, META)).rejects.toMatchObject({
      type: "FIRESTORE_TRANSIENT",
      nonRetryable: false,
    });
  });

  it("maps a missing stored token to CONNECTION_REAUTH", async () => {
    resolveAuthHeader.mockRejectedValue(
      new MissingConnectionTokenError("fs-1"),
    );
    await expect(callFirestoreQuery(QUERY, null, META)).rejects.toMatchObject({
      type: "CONNECTION_REAUTH",
      nonRetryable: true,
    });
  });

  it("maps an injected documentId to a non-retryable config error, with no call made", async () => {
    await expect(
      callFirestoreQuery({ ...QUERY, documentId: "../../admin" }, null, META),
    ).rejects.toMatchObject({
      type: "FIRESTORE_CONFIG_ERROR",
      nonRetryable: true,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never leaks the response body, which can echo document contents", async () => {
    fetchMock.mockResolvedValue(
      res(400, {
        error: { status: "INVALID_ARGUMENT", message: "ssn=123-45-6789" },
      }),
    );
    await expect(callFirestoreQuery(QUERY, null, META)).rejects.toMatchObject({
      message: expect.not.stringContaining("123-45-6789"),
    });
  });

  describe("bounds", () => {
    it("walks list pages up to maxPages and REPORTS truncation in the output", async () => {
      // Every page returns a continuation token, so the bound is what stops it.
      fetchMock.mockResolvedValue(
        res(200, { documents: [DOC], nextPageToken: "more" }),
      );
      const out = await callFirestoreQuery(
        { ...QUERY, action: "list", documentId: undefined, maxPages: 3 },
        null,
        META,
      );
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(out.count).toBe(3);
      // Announced in the OUTPUT so a graph can branch on it — not merely logged.
      expect(out.truncated).toBe(true);
    });

    it("does not report truncation when the collection simply ran out", async () => {
      fetchMock.mockResolvedValue(res(200, { documents: [DOC] })); // no nextPageToken
      const out = await callFirestoreQuery(
        { ...QUERY, action: "list", documentId: undefined, maxPages: 5 },
        null,
        META,
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(out.truncated).toBe(false);
    });

    it("clamps maxPages to the hard maximum", async () => {
      fetchMock.mockResolvedValue(
        res(200, { documents: [DOC], nextPageToken: "more" }),
      );
      await callFirestoreQuery(
        { ...QUERY, action: "list", documentId: undefined, maxPages: 10_000 },
        null,
        META,
      );
      expect(fetchMock).toHaveBeenCalledTimes(100);
    });
  });
});

describe("callFirestoreWrite", () => {
  it("encodes plain JSON into typed Firestore values", async () => {
    await callFirestoreWrite(WRITE, null, META);
    const body = JSON.parse(
      (fetchMock.mock.calls[0]?.[1] as { body: string }).body,
    ) as unknown;
    expect(body).toEqual({
      fields: {
        email: { stringValue: "a@b.co" },
        // The wire form of an integer is a STRING — the trap this node exists to hide.
        count: { integerValue: "5" },
      },
    });
  });

  it("returns the written document's identity", async () => {
    const out = await callFirestoreWrite(WRITE, null, META);
    expect(out).toMatchObject({
      status: "ok",
      name: DOC.name,
      documentId: "ada",
      deleted: false,
    });
  });

  it("reports a delete without parsing a document body", async () => {
    fetchMock.mockResolvedValue(res(200, {}));
    const out = await callFirestoreWrite(
      { ...WRITE, action: "delete" },
      null,
      META,
    );
    expect(out.deleted).toBe(true);
    expect(out.documentId).toBe("ada");
    expect((fetchMock.mock.calls[0]?.[1] as { method: string }).method).toBe(
      "DELETE",
    );
  });

  it("is AT-MOST-ONCE: even a transient 5xx becomes NON-retryable", async () => {
    // callSqlExec's rule. `create` has Firestore assign the id, so a Temporal retry
    // after an ambiguous failure would create a SECOND document.
    fetchMock.mockResolvedValue(res(503, { error: { status: "UNAVAILABLE" } }));
    await expect(callFirestoreWrite(WRITE, null, META)).rejects.toMatchObject({
      nonRetryable: true,
    });
  });

  it("refuses a value with no Firestore equivalent, before any call", async () => {
    await expect(
      callFirestoreWrite({ ...WRITE, data: { n: Number.NaN } }, null, META),
    ).rejects.toMatchObject({
      type: "FIRESTORE_CONFIG_ERROR",
      nonRetryable: true,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("emulator override", () => {
  it("targets the loopback emulator and sends NO credential to it", async () => {
    __firestoreDeps.emulatorHost = () => "127.0.0.1:8080";
    await callFirestoreQuery(QUERY, null, META);

    const [url, init] = fetchMock.mock.calls[0] as [
      string,
      { headers: Record<string, string> },
    ];
    expect(url).toBe(
      "http://127.0.0.1:8080/v1/projects/proj/databases/(default)/documents/users/ada",
    );
    // Posting a real tenant token to the emulator would be a genuine credential leak.
    expect(init.headers.Authorization).toBeUndefined();
    expect(resolveAuthHeader).not.toHaveBeenCalled();
    // Loopback would fail the public-address check, so the guard is skipped deliberately.
    expect(assertEgressAllowed).not.toHaveBeenCalled();
  });

  it("REFUSES a non-loopback emulator host rather than falling back to production", async () => {
    __firestoreDeps.emulatorHost = () => "evil.example.com:8080";
    await expect(callFirestoreQuery(QUERY, null, META)).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
