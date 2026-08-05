/**
 * The words on the CLI-login consent screen, and the lifetimes they quote.
 *
 * Separated from the component for two reasons:
 *
 *  1. The numbers below are a COPY of server constants. A consent screen that states the wrong
 *     token lifetime is worse than one that states none — the user is being asked to agree to
 *     something, and "expires in 12 hours" is part of what they agree to. `test/cli-login-copy.
 *     drift.spec.ts` reads the API's own constants and fails if these drift from them, so the
 *     duplication is checked rather than trusted.
 *  2. `failureCopy` is the "each failure must say what happened" requirement in one testable
 *     place, instead of a chain of ternaries inside JSX.
 */
import type { CliLoginFailureReason } from "../../lib/api";

/** `CLI_ACCESS_TOKEN_TTL_MS` — apps/api/src/auth/cli-auth.controller.ts */
export const CLI_ACCESS_TOKEN_TTL_HOURS = 12;
/** `REFRESH_IDLE_TTL_MS` — apps/api/src/auth/cli-refresh-token.service.ts */
export const CLI_REFRESH_IDLE_DAYS = 30;
/** `REFRESH_ABSOLUTE_TTL_MS` — apps/api/src/auth/cli-refresh-token.service.ts */
export const CLI_REFRESH_ABSOLUTE_DAYS = 90;
/** `CLI_AUTH_REQUEST_TTL_MS` — apps/api/src/auth/cli-auth-request.service.ts */
export const CLI_CODE_WINDOW_MINUTES = 10;

export interface FailureCopy {
  title: string;
  body: string;
  /** Whether "Enter another code" is a sensible next step (it isn't for a role refusal —
   *  a different code would be refused identically). */
  retry: boolean;
}

/**
 * What to tell the user for each way a decision can be refused.
 *
 * The three device-code reasons get OUR wording rather than the server's sentence, because the
 * server is answering an API caller and this is answering a person mid-security-decision: each one
 * here also says that nothing was authorized and what to do next, which the API's one-liners don't.
 * The machine-readable `reason` is the contract between them — not the prose — so an edit on
 * either side can't silently repoint a branch.
 *
 * `forbidden` and `unavailable` are the exceptions and take `serverMessage` VERBATIM: for those
 * two the server knows something we don't (which of the two 403s fired — wrong role, or an `nry_`
 * token principal with no user account at all — or which transport failed).
 */
export function failureCopy(
  reason: CliLoginFailureReason,
  serverMessage: string,
): FailureCopy {
  switch (reason) {
    case "expired":
      return {
        title: "That code has expired",
        body:
          `A login code is only good for ${CLI_CODE_WINDOW_MINUTES} minutes after your terminal ` +
          "prints it. Nothing was authorized and no token was issued. Run `naary auth` again to " +
          "get a fresh code.",
        retry: true,
      };
    case "already_decided":
      return {
        title: "That code has already been used",
        body:
          "A code works exactly once — this one was already approved, refused, or collected by a " +
          "terminal. Nothing new was authorized. If your CLI is still waiting, run `naary auth` " +
          "again for a new code.",
        retry: true,
      };
    case "unknown":
      return {
        title: "We don't recognise that code",
        body:
          "Nothing was authorized. Codes are 8 characters and never contain vowels or the digits " +
          "0, 1 and 5 — so an O typed for a 0, or an I for a J, lands here. Check it against your " +
          "terminal, or run `naary auth` again for a new one.",
        retry: true,
      };
    case "forbidden":
      return {
        title: "Your role can't authorize a CLI login",
        body: serverMessage,
        retry: false,
      };
    default:
      return {
        title: "That didn't go through",
        body: `${serverMessage} Nothing was authorized — you can try again.`,
        retry: true,
      };
  }
}
