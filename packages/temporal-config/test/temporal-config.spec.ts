import { describe, expect, it } from "vitest";
import { temporalConnectionConfig } from "../src/index";

const fakeRead = (p: string): Buffer => Buffer.from(`<contents of ${p}>`);

describe("temporalConnectionConfig", () => {
  it("defaults to the local dev server (no TLS, no key, ns 'default')", () => {
    const cfg = temporalConnectionConfig({}, fakeRead);
    expect(cfg).toEqual({ address: "localhost:7233", namespace: "default" });
    expect(cfg.tls).toBeUndefined();
    expect(cfg.apiKey).toBeUndefined();
  });

  it("honors explicit address + namespace", () => {
    const cfg = temporalConnectionConfig(
      {
        TEMPORAL_ADDRESS: "ns.acct.tmprl.cloud:7233",
        TEMPORAL_NAMESPACE: "ns.acct",
      },
      fakeRead,
    );
    expect(cfg.address).toBe("ns.acct.tmprl.cloud:7233");
    expect(cfg.namespace).toBe("ns.acct");
  });

  it("API key auto-enables TLS + routes the namespace via gRPC metadata", () => {
    const cfg = temporalConnectionConfig(
      { TEMPORAL_API_KEY: "tcld-secret", TEMPORAL_NAMESPACE: "prod.acct" },
      fakeRead,
    );
    expect(cfg.apiKey).toBe("tcld-secret");
    expect(cfg.tls).toBe(true);
    // Shared regional endpoint needs the namespace as a routing header.
    expect(cfg.metadata).toEqual({ "temporal-namespace": "prod.acct" });
  });

  it("sets no metadata when there is no API key", () => {
    expect(
      temporalConnectionConfig({ TEMPORAL_TLS: "true" }, fakeRead).metadata,
    ).toBeUndefined();
    expect(temporalConnectionConfig({}, fakeRead).metadata).toBeUndefined();
  });

  it("TEMPORAL_TLS=true forces plain TLS with no client cert", () => {
    const cfg = temporalConnectionConfig({ TEMPORAL_TLS: "true" }, fakeRead);
    expect(cfg.tls).toBe(true);
  });

  it("loads an mTLS client cert pair from the configured paths", () => {
    const cfg = temporalConnectionConfig(
      {
        TEMPORAL_TLS_CERT_PATH: "/secrets/client.pem",
        TEMPORAL_TLS_KEY_PATH: "/secrets/client.key",
        TEMPORAL_TLS_SERVER_NAME: "frontend.acct",
      },
      fakeRead,
    );
    expect(cfg.tls).toEqual({
      clientCertPair: {
        crt: Buffer.from("<contents of /secrets/client.pem>"),
        key: Buffer.from("<contents of /secrets/client.key>"),
      },
      serverNameOverride: "frontend.acct",
    });
  });

  it("fails loudly when only one half of the mTLS pair is set", () => {
    expect(() =>
      temporalConnectionConfig(
        { TEMPORAL_TLS_CERT_PATH: "/secrets/client.pem" },
        fakeRead,
      ),
    ).toThrow(/BOTH TEMPORAL_TLS_CERT_PATH and TEMPORAL_TLS_KEY_PATH/);
  });
});
