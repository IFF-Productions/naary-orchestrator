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
