/** `naary auth ...` — browser login, session status, and logout (#1078 slice 4). */

import { bool, parseCommand } from "../args";
import {
  maskToken,
  updateConfigFile,
  SESSION_FIELDS,
  type ConfigFile,
} from "../config";
import { authEnvironment, type CommandContext } from "../context";
import { deviceLogin } from "../device-login";
import { GROUP_HELP } from "../help";
import {
  clearSession,
  readSession,
  revokeSession,
  saveSession,
} from "../session";

/**
 * `naary auth login` — the browser handshake, or `--token` to paste one by hand.
 *
 * The browser is not a convenience here: #1078 §1 measured that App Check rejects a password grant
 * before it ever evaluates the credentials, so the browser is the only thing that can perform the
 * login at all. This command's job is to show a code, wait politely, and store what comes back.
 */
export async function authLogin(
  argv: string[],
  ctx: CommandContext,
): Promise<number> {
  const args = parseCommand(argv, { "no-browser": { type: "boolean" } });
  if (args.help) {
    ctx.io.out(GROUP_HELP.auth);
    return 0;
  }
  const env = authEnvironment(ctx);
  const { config } = ctx.makeClient(args.configFlags);

  // Preferences the user passed alongside the login. Written whichever branch we take.
  const prefs: ConfigFile = {};
  if (args.configFlags.apiUrl) prefs.apiUrl = args.configFlags.apiUrl;
  if (args.configFlags.env) prefs.env = args.configFlags.env;

  const pasted = args.configFlags.token;
  if (pasted) {
    /**
     * The pre-#1078 path, kept working: a token minted in Settings (or a CI token) pasted straight
     * in. The session fields are CLEARED rather than merged around, because leaving a refresh token
     * from an earlier browser login next to a hand-pasted token means the first 401 quietly rotates
     * the user back onto the OTHER credential — a token they did not ask for, from a session they
     * thought they had replaced.
     */
    const cleared: Record<string, undefined> = {};
    for (const field of SESSION_FIELDS) cleared[field] = undefined;
    updateConfigFile({ ...cleared, ...prefs, token: pasted }, env.configFile);
    ctx.io.out(
      `Saved credentials to ${env.configFile} (token ${maskToken(pasted)}).`,
    );
    return 0;
  }

  const apiUrl = args.configFlags.apiUrl ?? config.apiUrl;
  const result = await deviceLogin({
    apiUrl,
    fetch: env.fetch,
    sleep: env.sleep,
    now: env.now,
    hostname: env.hostname(),
    openBrowser: bool(args.values["no-browser"]) ? undefined : env.openBrowser,
    onPrompt: (prompt) => {
      ctx.io.out("");
      ctx.io.out(
        `  Open:  ${prompt.verificationUri}${prompt.browserOpened ? "  (opening in your browser…)" : ""}`,
      );
      ctx.io.out(`  Code:  ${prompt.userCode}`);
      ctx.io.out("");
      ctx.io.out(
        `Waiting for approval — this code expires in ${Math.round(prompt.expiresIn / 60)} minute(s).`,
      );
      // Not discoverable from the flow itself: the CLI cannot tell "nobody approved yet" from
      // "the person who tried was refused", because the 403 happens in the browser and the
      // handshake just stays pending. Saying so up front is cheaper than a ten-minute wait
      // followed by a bare "expired".
      ctx.io.out(
        "(Approving a CLI login requires a workspace owner or admin account.)",
      );
    },
  });

  if (!result.ok) {
    ctx.io.err(result.message);
    return 1;
  }

  if (Object.keys(prefs).length) updateConfigFile(prefs, env.configFile);
  const replaced = readSession(env.configFile);
  saveSession(result.session, env.configFile);

  /**
   * Retire the session this one replaced. Without it, logging in again leaves the OLD refresh
   * family live to its 90-day cap with nobody holding it — a credential that can still mint access
   * tokens and that the user believes they replaced.
   *
   * AFTER the new session is stored, never before: revoking up front would destroy a working
   * session on behalf of a login that might then be denied or time out. Best-effort — the login
   * succeeded, and a failure to tidy up must not turn it into an error. Skipped when the previous
   * credential had no refresh token, because then it was hand-pasted and is not ours to revoke.
   */
  if (replaced?.refreshToken) {
    await revokeSession(
      { apiUrl, fetch: env.fetch, file: env.configFile },
      {
        refreshToken: replaced.refreshToken,
        accessToken: replaced.accessToken,
      },
    ).catch(() => false);
  }

  const workspace = result.session.tenantId
    ? ` for workspace ${result.session.tenantId}`
    : "";
  ctx.io.out(`Logged in${workspace}. Session saved to ${env.configFile}.`);
  if (result.session.accessTokenExpiresAt) {
    ctx.io.out(
      `Access token expires ${result.session.accessTokenExpiresAt}${
        result.session.refreshToken
          ? " and is renewed automatically."
          : " (no refresh token — you will need to log in again)."
      }`,
    );
  }
  return 0;
}

/** `naary auth status` — what credential is in effect, where it came from, and how long it lasts. */
export async function authStatus(
  argv: string[],
  ctx: CommandContext,
): Promise<number> {
  const args = parseCommand(argv);
  if (args.help) {
    ctx.io.out(GROUP_HELP.auth);
    return 0;
  }
  const env = authEnvironment(ctx);
  // Through the context's resolver, not `loadConfig` directly: `status` must report the SAME
  // config every other command will use, and going around the context is also what made this
  // command untestable (it read the developer's real ~/.naary).
  const { config } = ctx.makeClient(args.configFlags);
  const session = readSession(env.configFile);

  ctx.io.out(`API URL: ${config.apiUrl}`);
  ctx.io.out(
    `Token:   ${config.token ? maskToken(config.token) : "(not set)"}${
      config.tokenSource ? `  [from ${sourceLabel(config.tokenSource)}]` : ""
    }`,
  );
  // Only meaningful for the stored session: a flag/env token's expiry is not ours to know.
  if (config.tokenSource === "file" && session?.accessTokenExpiresAt) {
    ctx.io.out(
      `Expires: ${session.accessTokenExpiresAt}${expiryNote(session.accessTokenExpiresAt, env.now())}`,
    );
  }
  if (config.tokenSource === "file") {
    ctx.io.out(
      `Refresh: ${
        session?.refreshToken
          ? `stored${session.refreshTokenExpiresAt ? `, session ends ${session.refreshTokenExpiresAt}` : ""}`
          : "(none — `naary auth login` to get one)"
      }`,
    );
  }
  if (session?.tenantId) ctx.io.out(`Workspace: ${session.tenantId}`);
  ctx.io.out(`Env:     ${config.env ?? "(default)"}`);
  ctx.io.out(`Config:  ${env.configFile}`);
  return 0;
}

/**
 * `naary auth logout` — end the session on the SERVER, then forget it locally.
 *
 * Order matters: the server call needs the tokens, so it goes first. It is best-effort — an
 * offline laptop must still be able to forget its credentials — but a local-only logout would
 * leave a refresh family alive for up to 90 days (#1078 §4), which is the opposite of what
 * "log out" means, so a failure to reach the server is REPORTED rather than swallowed.
 */
export async function authLogout(
  argv: string[],
  ctx: CommandContext,
): Promise<number> {
  const args = parseCommand(argv);
  if (args.help) {
    ctx.io.out(GROUP_HELP.auth);
    return 0;
  }
  const env = authEnvironment(ctx);
  const { config } = ctx.makeClient(args.configFlags);
  const session = readSession(env.configFile);
  if (!session) {
    ctx.io.out("Not logged in — nothing to do.");
    return 0;
  }

  /**
   * A hand-pasted token has no server-side session to end — and saying "Session revoked." about a
   * shared Settings/CI credential that is still perfectly live is the exact false reassurance the
   * offline branch below exists to avoid. Nothing is sent (see `revokeSession`), so nothing may be
   * claimed.
   */
  if (!session.refreshToken) {
    clearSession(env.configFile);
    ctx.io.out(`Cleared the stored token from ${env.configFile}.`);
    ctx.io.out(
      "It was not a browser session, so nothing was revoked server-side — delete it in Settings if it should stop working.",
    );
    return 0;
  }

  const revoked = await revokeSession({
    apiUrl: config.apiUrl,
    fetch: env.fetch,
    file: env.configFile,
  });
  clearSession(env.configFile);
  ctx.io.out(`Cleared the stored session from ${env.configFile}.`);
  if (!revoked) {
    ctx.io.err(
      "Could not reach the server to revoke the session — the refresh token may still be live. Revoke it in Settings if this was not your machine.",
    );
    return 1;
  }
  ctx.io.out("Session revoked.");
  return 0;
}

function sourceLabel(source: "flag" | "env" | "file"): string {
  return source === "flag"
    ? "--token"
    : source === "env"
      ? "NAARY_TOKEN"
      : "config file";
}

/** " (expired)" / " (in 3h)" — the reason a command might be about to refresh. */
function expiryNote(iso: string, now: number): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "";
  const ms = at - now;
  if (ms <= 0) return "  (expired — the next command will renew it)";
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.round((ms % 3_600_000) / 60_000);
  return `  (in ${hours ? `${hours}h ` : ""}${minutes}m)`;
}

export const AUTH_COMMANDS: Record<
  string,
  (argv: string[], ctx: CommandContext) => Promise<number>
> = {
  login: authLogin,
  status: authStatus,
  logout: authLogout,
};
