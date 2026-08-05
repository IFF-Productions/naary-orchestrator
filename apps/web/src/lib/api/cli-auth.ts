/**
 * The browser half of `naary auth` (#1078 §2 shape B, slice 3): approve or deny a pending CLI
 * login as the signed-in user.
 *
 * HAND-ROLLED rather than routed through `http()`, for the same reason `introspectPost` is: the
 * shared client keeps only `code` and `message` off an error body and discards everything else,
 * and this screen's whole job is to tell three failures apart. `POST /auth/cli/{approve,deny}`
 * answers 400 with a `reason` of `expired` / `already_decided` / `unknown`, and a consent screen
 * that collapsed those into one "something went wrong" would be the worst possible copy on the
 * worst possible page. `http()`'s own `message` is also unusable here — it appends the request
 * context (`… (POST /auth/cli/approve → 400)`), which is diagnostics, not consent copy.
 *
 * There is deliberately NO read endpoint to call first. `POST /auth/cli/start` returns a
 * verification URI with no code in it, and the API exposes no lookup by user code — so the browser
 * cannot preflight "what am I authorizing?", and this module must not invent a way to. Retyping
 * the code from the terminal IS the anti-phishing property of the flow: with no code in the URL,
 * an attacker who starts a login cannot hand a victim a link that pre-fills their code. The device
 * label ("naary CLI — <hostname>") comes back in the DECISION's response, which is where the page
 * shows it.
 */
import { apiHeaders, BASE, UnauthorizedError } from "./http";

/** Why a decision could not be applied — the server's machine-readable twin of its message. */
export type CliLoginFailureReason =
  /** Past the 10-minute window the CLI's code lives for. */
  | "expired"
  /** Approved, denied or already redeemed — a code works exactly once. */
  | "already_decided"
  /** No pending request with that code (a typo, or a code from another deployment). */
  | "unknown"
  /** Signed in, but this principal may not DECIDE a CLI login — owner/admin only, and a real user
   *  account (an `nry_` token principal has no user and is refused too). Note this gates BOTH
   *  approve and deny: the server's `assertMayApprove` runs on each, because a denial is a
   *  decision on the same row and leaving it open would let anyone who learns a user code cancel
   *  someone else's login. So this state must never assume which button was pressed. */
  | "forbidden"
  /** Client-side only, never a server answer: the session died before the click, so nothing was
   *  submitted. Distinct from `forbidden` (the role is fine) and from `unknown` (the code is
   *  fine) — re-entering the code would fail identically until the user signs in again. */
  | "session_expired"
  /** Anything else: network, 5xx, a body we couldn't read. */
  | "unavailable";

/** A refused decision, carrying both the reason to branch on and the server's own sentence. */
export class CliLoginError extends Error {
  constructor(
    readonly reason: CliLoginFailureReason,
    /** The API's message, VERBATIM — no request context appended. Rendered to the user. */
    readonly serverMessage: string,
  ) {
    super(serverMessage);
    this.name = "CliLoginError";
  }
}

export interface CliLoginDecision {
  status: "approved" | "denied";
  /** The token label the request was opened with — `naary CLI — <hostname>`. The only thing the
   *  browser ever learns about the device on the other end, and it arrives only after deciding. */
  label: string;
}

export const cliAuthApi = {
  /**
   * Approve or deny a pending CLI login.
   *
   * `userCode` must already be canonical (see lib/cli-user-code); the server re-normalizes anyway.
   * Denying is a real call, not a navigation: the CLI is polling and gets a definite "denied"
   * instead of timing out ten minutes later, and the code is burned so nobody else can use it.
   */
  async decideCliLogin(
    userCode: string,
    decision: "approve" | "deny",
  ): Promise<CliLoginDecision> {
    let res: Response;
    try {
      res = await fetch(`${BASE}/auth/cli/${decision}`, {
        method: "POST",
        cache: "no-store",
        headers: await apiHeaders(),
        body: JSON.stringify({ userCode }),
      });
    } catch {
      throw new CliLoginError(
        "unavailable",
        "Couldn't reach Naary. Check your connection and try again.",
      );
    }
    // 401 keeps the app-wide meaning (session gone) so the caller can bounce to sign-in rather
    // than render "your role can't do this" at someone whose session simply expired.
    if (res.status === 401) throw new UnauthorizedError();
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as {
        reason?: string;
        message?: string | string[];
      } | null;
      const message = Array.isArray(body?.message)
        ? body?.message[0]
        : body?.message;
      throw new CliLoginError(
        classify(res.status, body?.reason),
        typeof message === "string" && message.trim()
          ? message.trim()
          : `The request was refused (${res.status}).`,
      );
    }
    return (await res.json()) as CliLoginDecision;
  },
};

/** Trust the server's `reason` only for the values we know; anything else degrades to a stated
 *  generic rather than a branch nobody wrote. A 403 has no `reason` — the status IS the reason. */
function classify(status: number, reason?: string): CliLoginFailureReason {
  if (status === 403) return "forbidden";
  if (
    reason === "expired" ||
    reason === "already_decided" ||
    reason === "unknown"
  ) {
    return reason;
  }
  return "unavailable";
}
