import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { __setObjectStore, MemoryObjectStore } from "@naary/storage";
import { callHash } from "../src/temporal/activities";

const meta = { tenantId: "t-1", executionId: "e-1", nodeId: "n-1" };

beforeEach(() => {
  __setObjectStore(new MemoryObjectStore());
});

describe("callHash", () => {
  it("sha256 hex of a string matches node:crypto", async () => {
    const r = await callHash(
      { algorithm: "sha256", input: "hello", encoding: "hex" },
      undefined,
      meta,
    );
    expect(r.digest).toBe(createHash("sha256").update("hello").digest("hex"));
  });

  it("honors algorithm + base64 encoding", async () => {
    const r = await callHash(
      { algorithm: "md5", input: "hello", encoding: "base64" },
      undefined,
      meta,
    );
    expect(r.digest).toBe(createHash("md5").update("hello").digest("base64"));
  });

  it("hashes an object as its JSON string", async () => {
    const obj = { a: 1, b: "x" };
    const r = await callHash(
      { algorithm: "sha512", input: obj, encoding: "hex" },
      undefined,
      meta,
    );
    expect(r.digest).toBe(
      createHash("sha512").update(JSON.stringify(obj)).digest("hex"),
    );
  });
});
