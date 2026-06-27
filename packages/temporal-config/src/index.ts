/**
 * Resolve the Temporal connection config from env, shared by the API client
 * (`@temporalio/client` Connection) and the worker (`@temporalio/worker`
 * NativeConnection) — both accept the same `{ address, tls, apiKey }` shape, with
 * `namespace` passed to the Client / Worker (PRODUCTION-READINESS §3.A).
 *
 * Defaults to the local dev server (localhost:7233, no TLS, namespace "default"),
 * so existing dev/docker setups are byte-for-byte unchanged. Temporal Cloud is
 * enabled purely by setting env — no code change:
 *
 *   API key:   TEMPORAL_ADDRESS + TEMPORAL_NAMESPACE + TEMPORAL_API_KEY
 *              (TLS is auto-enabled — Cloud mandates it)
 *   mTLS:      TEMPORAL_ADDRESS + TEMPORAL_NAMESPACE +
 *              TEMPORAL_TLS_CERT_PATH + TEMPORAL_TLS_KEY_PATH
 *   plain TLS: TEMPORAL_TLS=true
 *
 * This is BOOT code (reads files / env) — never import it from workflow code.
 */
import { readFileSync } from "node:fs";

/**
 * Structurally matches `@temporalio/common`'s `TLSConfig` (identical in the
 * client + worker SDKs at 1.18). Declared locally so this stays a dependency-free
 * util; the connect call sites validate compatibility at compile time.
 */
export interface TlsConfig {
  serverNameOverride?: string;
  serverRootCACertificate?: Uint8Array;
  clientCertPair?: { crt: Uint8Array; key: Uint8Array };
}

export interface TemporalConnectionConfig {
  /** `hostname:port` — the local dev server by default. */
  address: string;
  /** Passed to `new Client({ namespace })` / `Worker.create({ namespace })`. */
  namespace: string;
  /** Connection TLS: `true` for API-key/Cloud, an object for mTLS, omitted for plaintext dev. */
  tls?: TlsConfig | boolean;
  /** Temporal Cloud API key (sets the connection's Authorization header). */
  apiKey?: string;
  /**
   * gRPC metadata sent with every request on the connection. Set for API-key
   * auth: Temporal Cloud API keys connect to a SHARED regional endpoint, so the
   * namespace must travel as the `temporal-namespace` header for routing — the
   * Connection object itself doesn't know the Client/Worker namespace.
   */
  metadata?: Record<string, string>;
}

type Env = Record<string, string | undefined>;
type ReadFile = (path: string) => Buffer;

export function temporalConnectionConfig(
  env: Env = process.env,
  readFile: ReadFile = readFileSync,
): TemporalConnectionConfig {
  const address = env.TEMPORAL_ADDRESS?.trim() || "localhost:7233";
  const namespace = env.TEMPORAL_NAMESPACE?.trim() || "default";
  const apiKey = env.TEMPORAL_API_KEY?.trim() || undefined;
  const certPath = env.TEMPORAL_TLS_CERT_PATH?.trim();
  const keyPath = env.TEMPORAL_TLS_KEY_PATH?.trim();

  let tls: TlsConfig | boolean | undefined;
  if (certPath && keyPath) {
    // mTLS: load the client cert pair (a boot-time file read, never in a workflow).
    const clientCertPair = { crt: readFile(certPath), key: readFile(keyPath) };
    const serverNameOverride = env.TEMPORAL_TLS_SERVER_NAME?.trim();
    tls = serverNameOverride
      ? { clientCertPair, serverNameOverride }
      : { clientCertPair };
  } else if (certPath || keyPath) {
    // One half of the pair without the other is a misconfiguration — fail loudly
    // at boot rather than silently connecting without the client certificate.
    throw new Error(
      "Temporal mTLS requires BOTH TEMPORAL_TLS_CERT_PATH and TEMPORAL_TLS_KEY_PATH",
    );
  } else if (apiKey || env.TEMPORAL_TLS === "true") {
    // API-key auth (Temporal Cloud) requires TLS; also allow forcing plain TLS.
    tls = true;
  }

  const config: TemporalConnectionConfig = { address, namespace };
  if (tls !== undefined) config.tls = tls;
  if (apiKey) {
    config.apiKey = apiKey;
    // Route to the namespace over the shared API-key endpoint (see `metadata` doc).
    config.metadata = { "temporal-namespace": namespace };
  }
  return config;
}
