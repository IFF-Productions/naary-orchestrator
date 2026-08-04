/** Thrown when a connection has no usable token — surfaces as needs_reauth, non-retryable. */
export class MissingConnectionTokenError extends Error {
  constructor(public readonly connectionId: string) {
    super(`Connection '${connectionId}' has no stored token`);
    this.name = "MissingConnectionTokenError";
  }
}

/** Thrown when an OAuth refresh fails (invalid_grant / revoked) — the connection
 *  must be re-consented. The worker maps this to a non-retryable failure. */
export class NeedsReauthError extends Error {
  constructor(public readonly connectionId: string) {
    super(`Connection '${connectionId}' needs re-authorization`);
    this.name = "NeedsReauthError";
  }
}

/**
 * Thrown when a PLATFORM auth prerequisite is missing (e.g. the GitHub App isn't
 * configured — no GITHUB_APP_ID / private key). This is an OPS problem, not a tenant
 * reconnect: retrying can't fix it, so the worker maps it to a NON-retryable failure
 * (and it must NOT flip the connection to needs_reauth — nothing the user can do). */
export class AuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthConfigError";
  }
}

/** Why an interactive connect callback couldn't complete — all USER-RECOVERABLE. */
export type ConnectCallbackReason =
  | "missing_params" // the provider hit our callback without the params we require
  | "unknown_or_expired" // the single-use state isn't in the store (spent, swept, or never issued)
  | "expired"; // the state was found but past its TTL

/**
 * A user-recoverable failure of an interactive connect callback (GitHub App install or
 * OAuth consent): the single-use `state` is absent, unknown, or past its TTL. These are
 * NOT server faults — the user just restarts the connect flow — so the API maps them to a
 * 4xx (never a 500), keeping them OUT of high-priority error alerting. Genuine faults
 * (store/provider errors) and security signals (tenant/issuer mismatch, a tampered state)
 * are deliberately NOT this error, so they stay a loud 500 that pages. Callbacks still fail
 * CLOSED on any of these — no connection is created. */
export class ConnectCallbackError extends Error {
  constructor(
    public readonly reason: ConnectCallbackReason,
    message: string,
  ) {
    super(message);
    this.name = "ConnectCallbackError";
  }
}

/**
 * The server we were asked to connect to does not publish usable OAuth metadata.
 *
 * Reported from production (Sentry NAARY-API-4) as `BlockedEgressError: Blocked outbound request:
 * invalid URL`, which is a true statement about the wrong thing. What had actually happened:
 * `/.well-known/oauth-protected-resource` and `/.well-known/oauth-authorization-server` both 404'd,
 * `asm.token_endpoint` was therefore `undefined`, `String(undefined)` produced the literal
 * `"undefined"`, and the egress guard — correctly — refused to fetch a URL that will not parse. The
 * user was shown an SSRF error for a server that simply isn't an OAuth authorization server.
 *
 * So discovery now says what it found — and distinguishes WHY, because the two cases deserve
 * different answers. A 404 means the server does not implement this flow and no amount of retrying
 * changes that: the user's request is the thing to fix (4xx). A 500 or a network failure means the
 * server may well implement it and be having a bad minute: telling that user "your request is
 * wrong" is false, and telling them not to retry is worse. That is what `transient` carries.
 */
export class OAuthDiscoveryError extends Error {
  constructor(
    /** The origin whose metadata was being read — named so the message is actionable. */
    public readonly origin: string,
    detail: string,
    /**
     * The failure is on the OTHER server's side and may not recur — a 5xx, a gateway timeout, a
     * connection reset. The API answers these with a 502 rather than a 400: "we couldn't reach
     * them" and "you asked for the wrong thing" are different sentences, and only one of them is
     * worth retrying.
     */
    public readonly transient = false,
    /** The upstream HTTP status, when there was one. Diagnostic only. */
    public readonly upstreamStatus?: number,
  ) {
    super(`No usable OAuth metadata at ${origin}: ${detail}`);
    this.name = "OAuthDiscoveryError";
  }
}
