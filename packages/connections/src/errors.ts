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
