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
