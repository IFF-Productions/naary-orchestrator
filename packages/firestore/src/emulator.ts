/**
 * `FIRESTORE_EMULATOR_HOST` support — the well-known local Firestore emulator, so this
 * node can be tested end-to-end with no Google project and no real credential.
 *
 * The obvious risk is that "base URL from an env var" becomes a way to point production at
 * an attacker's host, so two rules keep it shut:
 *
 *   1. The value is read ONLY from the worker process's own environment. It never comes
 *      from node config, connection data, or anything else a tenant can set — so a tenant
 *      cannot reach it at all.
 *   2. It must name a LOOPBACK host. Even the operator who sets the variable cannot aim
 *      this off-box, so a typo or a leaked deploy env can't exfiltrate documents.
 *
 * When the emulator is active the request carries NO Authorization header: the emulator has
 * no auth, and sending a real tenant token to it would be a genuine credential leak.
 */

/** Hostnames that are unambiguously this machine. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export class FirestoreEmulatorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FirestoreEmulatorError";
  }
}

/**
 * Turn a `FIRESTORE_EMULATOR_HOST` value (`127.0.0.1:8080`) into a base URL, or return
 * `null` when unset/blank (⇒ use the real Firestore).
 *
 * Throws on a non-loopback host rather than falling back to production: a worker
 * configured to hit an emulator that is not actually local is misconfigured, and silently
 * sending its tenant's documents to Google instead would be the worse surprise.
 */
export function resolveEmulatorBaseUrl(raw: string | undefined): string | null {
  const value = (raw ?? "").trim();
  if (!value) return null;

  // No scheme in the canonical form, but tolerate one rather than build `http://http://…`.
  const stripped = value.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  if (!stripped) return null;

  let host: string;
  let port: string;
  try {
    const u = new URL(`http://${stripped}`);
    host = u.hostname;
    port = u.port;
  } catch {
    throw new FirestoreEmulatorError(
      `FIRESTORE_EMULATOR_HOST is not a valid host:port ("${value}")`,
    );
  }

  if (!LOOPBACK_HOSTS.has(host)) {
    throw new FirestoreEmulatorError(
      `FIRESTORE_EMULATOR_HOST must be a loopback address (localhost / 127.0.0.1 / ::1) — got "${host}". ` +
        "The emulator override is deliberately limited to this machine so it cannot redirect production traffic.",
    );
  }

  return `http://${host === "::1" ? "[::1]" : host}${port ? `:${port}` : ""}`;
}

/** True when the emulator override is active for this worker process. */
export function isEmulatorBase(baseUrl: string): boolean {
  return baseUrl.startsWith("http://");
}
