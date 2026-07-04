import { createHmac, generateKeyPairSync } from "node:crypto";
import { importSPKI, jwtVerify } from "jose";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MissingConnectionTokenError } from "@naary/connections";
import {
  __setObjectStore,
  MemoryObjectStore,
  maybeOffload,
} from "@naary/storage";
import { __signingDeps, callHmac, callJwt } from "../src/temporal/activities";

const KEY = "super-secret-signing-key";
const meta = { tenantId: "t-1", executionId: "e-1", nodeId: "n-1" };

const resolveSigningKey = vi.fn();
let store: MemoryObjectStore;
beforeEach(() => {
  resolveSigningKey.mockReset();
  __signingDeps.resolveSigningKey = resolveSigningKey as never;
  store = new MemoryObjectStore();
  __setObjectStore(store);
});

describe("callHmac", () => {
  it("signs the payload with the connection's key (digest verifies)", async () => {
    resolveSigningKey.mockResolvedValue(KEY);
    const r = await callHmac(
      {
        connectionId: "sign-1",
        algorithm: "sha256",
        payload: "hello",
        encoding: "hex",
      },
      undefined,
      meta,
    );
    const expected = createHmac("sha256", KEY).update("hello").digest("hex");
    expect(r).toEqual({ status: "ok", digest: expected, costUsd: 0 });
    // the resolver was asked for THIS tenant's connection
    expect(resolveSigningKey).toHaveBeenCalledWith("t-1", "sign-1");
  });

  it("REHYDRATES a claim-checked payload before signing (signs the data, not the ref)", async () => {
    resolveSigningKey.mockResolvedValue(KEY);
    // A large upstream value gets offloaded into the SAME store the activity reads
    // → the bound payload is a claim-check ref, not the data.
    const big = { blob: "x".repeat(1_100_000) };
    const offloaded = await maybeOffload(big, store, { keyPrefix: "test" });
    expect(offloaded).toHaveProperty("__claimCheck"); // sanity: it IS a ref

    const r = await callHmac(
      {
        connectionId: "sign-1",
        algorithm: "sha256",
        payload: offloaded,
        encoding: "hex",
      },
      undefined,
      meta,
    );
    // digest must be over the REAL data, not the reference object
    const expected = createHmac("sha256", KEY)
      .update(JSON.stringify(big))
      .digest("hex");
    expect(r.digest).toBe(expected);
    // and NOT the digest of the raw reference (the bug this guards against)
    const refDigest = createHmac("sha256", KEY)
      .update(JSON.stringify(offloaded))
      .digest("hex");
    expect(r.digest).not.toBe(refDigest);
  });

  it("a missing key → non-retryable, and the key never leaks", async () => {
    resolveSigningKey.mockRejectedValue(
      new MissingConnectionTokenError("sign-1"),
    );
    const err = await callHmac(
      {
        connectionId: "sign-1",
        algorithm: "sha256",
        payload: "x",
        encoding: "hex",
      },
      undefined,
      meta,
    ).catch((e) => e);
    expect(err.nonRetryable).toBe(true);
    expect(err.type).toBe("CONNECTION_REAUTH");
    expect(JSON.stringify(err)).not.toContain(KEY);
  });
});

describe("callJwt", () => {
  it("mints an HS256 token that verifies with the same key + carries the claims/exp", async () => {
    resolveSigningKey.mockResolvedValue(KEY);
    const r = await callJwt(
      {
        connectionId: "sign-1",
        algorithm: "HS256",
        claims: { sub: "u-7" },
        expiresInSeconds: 3600,
      },
      undefined,
      meta,
    );
    expect(r.status).toBe("ok");
    const { payload, protectedHeader } = await jwtVerify(
      r.token,
      new TextEncoder().encode(KEY),
    );
    expect(protectedHeader.alg).toBe("HS256");
    expect(payload.sub).toBe("u-7");
    expect(typeof payload.iat).toBe("number");
    expect(typeof payload.exp).toBe("number");
  });

  it("a wrong key fails verification (proves it was actually signed)", async () => {
    resolveSigningKey.mockResolvedValue(KEY);
    const r = await callJwt(
      { connectionId: "sign-1", algorithm: "HS256", claims: { sub: "u-7" } },
      undefined,
      meta,
    );
    await expect(
      jwtVerify(r.token, new TextEncoder().encode("the-wrong-key")),
    ).rejects.toThrow();
  });

  it("mints an RS256 token signed by a PEM private key; verifies with the public key", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
    });
    const pkcs8 = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
    const spki = publicKey.export({ type: "spki", format: "pem" }) as string;
    resolveSigningKey.mockResolvedValue(pkcs8); // the signing connection holds the PEM

    const r = await callJwt(
      { connectionId: "sign-1", algorithm: "RS256", claims: { sub: "svc-1" } },
      undefined,
      meta,
    );
    expect(r.status).toBe("ok");
    const { payload, protectedHeader } = await jwtVerify(
      r.token,
      await importSPKI(spki, "RS256"),
    );
    expect(protectedHeader.alg).toBe("RS256");
    expect(payload.sub).toBe("svc-1");
  });
});
