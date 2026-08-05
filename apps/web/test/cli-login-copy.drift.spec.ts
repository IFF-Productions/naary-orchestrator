import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  displayUserCode,
  formatUserCodeInput,
  normalizeUserCode,
  USER_CODE_ALPHABET,
  USER_CODE_LENGTH,
} from "../src/lib/cli-user-code";
import {
  CLI_ACCESS_TOKEN_TTL_HOURS,
  CLI_CODE_WINDOW_MINUTES,
  CLI_REFRESH_ABSOLUTE_DAYS,
  CLI_REFRESH_IDLE_DAYS,
  failureCopy,
  forbiddenGuidance,
} from "../src/screens/app/cli-login.copy";

/**
 * The CLI-login consent screen states four lifetimes and validates the user code — all of which
 * are DUPLICATES of server-side facts. Two duplications, two different risks:
 *
 *  - The lifetimes are what the user is being asked to agree to. "Expires in 12 hours" on a screen
 *    where the server mints a 24-hour token isn't a stale string, it's a false statement obtained
 *    under consent. Nothing else in the app would fail if it drifted.
 *  - The code alphabet/length decides whether the Approve button is even reachable. If the server
 *    lengthened the code, the browser would silently refuse every valid one.
 *
 * So this reads the API's own source and asserts the numbers agree. The API is not importable from
 * the web tests (separate tsconfig/runtime), which is why this parses text — and the parse is
 * guarded: every regex must match, or the test fails rather than passing vacuously.
 */

const API = resolve(__dirname, "../../api/src/auth");

function read(file: string): string {
  return readFileSync(resolve(API, file), "utf8");
}

/** Pull `export const NAME = <expr>;` and evaluate the arithmetic (`12 * 60 * 60 * 1000`). */
function constant(source: string, name: string): number {
  const m = source.match(new RegExp(`export const ${name} = ([^;]+);`));
  expect(m, `${name} not found — has the API constant been renamed?`).not.toBe(
    null,
  );
  const expr = (m as RegExpMatchArray)[1].replace(/\s|_/g, "");
  expect(expr, `${name} is not plain arithmetic: ${expr}`).toMatch(
    /^[0-9*+]+$|^[0-9]+\*DAY$/,
  );
  // `DAY` is the only identifier the refresh service uses.
  const value = expr.includes("DAY")
    ? Number(expr.replace("*DAY", "")) * 86_400_000
    : expr.split("*").reduce((acc, part) => acc * Number(part), 1);
  expect(Number.isFinite(value) && value > 0).toBe(true);
  return value;
}

describe("CLI-login consent copy matches the server it describes", () => {
  const controller = read("cli-auth.controller.ts");
  const refresh = read("cli-refresh-token.service.ts");
  const requests = read("cli-auth-request.service.ts");

  /** Guard the guard: `constant()` expands `90 * DAY` using a hardcoded day, so pin the API's
   *  own `DAY` — if it ever meant something else, every lifetime below would agree vacuously. */
  it("reads the same DAY the refresh service defines", () => {
    expect(refresh).toMatch(/const DAY = 24 \* 60 \* 60 \* 1000;/);
  });

  it("quotes the real access-token TTL", () => {
    expect(constant(controller, "CLI_ACCESS_TOKEN_TTL_MS")).toBe(
      CLI_ACCESS_TOKEN_TTL_HOURS * 3_600_000,
    );
  });

  it("quotes the real refresh idle + absolute lifetimes", () => {
    expect(constant(refresh, "REFRESH_IDLE_TTL_MS")).toBe(
      CLI_REFRESH_IDLE_DAYS * 86_400_000,
    );
    expect(constant(refresh, "REFRESH_ABSOLUTE_TTL_MS")).toBe(
      CLI_REFRESH_ABSOLUTE_DAYS * 86_400_000,
    );
  });

  it("quotes the real code window", () => {
    expect(constant(requests, "CLI_AUTH_REQUEST_TTL_MS")).toBe(
      CLI_CODE_WINDOW_MINUTES * 60_000,
    );
  });

  it("points the user at the SPA route the API hands the CLI", () => {
    expect(controller).toContain('CLI_VERIFICATION_PATH = "/app/cli-login"');
    const routerSrc = readFileSync(
      resolve(__dirname, "../src/router.tsx"),
      "utf8",
    );
    expect(routerSrc).toContain('path: "/app/cli-login"');
  });

  it("validates the code with the server's alphabet and length", () => {
    expect(requests).toContain(`USER_CODE_ALPHABET = "${USER_CODE_ALPHABET}"`);
    expect(requests).toContain(`USER_CODE_LENGTH = ${USER_CODE_LENGTH}`);
  });

  /**
   * The verification URI carries NO code, and there is no lookup endpoint — which is what makes
   * "type the code from your terminal" the anti-phishing control. If a future change added a code
   * to the URI, a prefill would become tempting, and a link an attacker sends could carry THEIR
   * code. This is the tripwire for that conversation happening deliberately.
   */
  it("still hands the CLI a verification URI with no code in it", () => {
    expect(controller).toContain(
      "verificationUri: `${appBaseUrl()}${CLI_VERIFICATION_PATH}`",
    );
    const screen = readFileSync(
      resolve(__dirname, "../src/screens/app/CliLogin.tsx"),
      "utf8",
    );
    expect(screen).not.toContain("useSearchParams");
  });
});

describe("user code normalization", () => {
  it("accepts what a human actually pastes", () => {
    for (const raw of ["PQ4M-TWZ9", "pq4m-twz9", "pq4m twz9", "PQ4MTWZ9  \n"]) {
      expect(normalizeUserCode(raw)).toBe("PQ4MTWZ9");
    }
  });

  it("returns nothing until the code is complete — so the button stays disabled", () => {
    expect(normalizeUserCode("PQ4M")).toBe("");
    expect(normalizeUserCode("PQ4M-TWZ")).toBe("");
    expect(normalizeUserCode(undefined)).toBe("");
    // Nine alphabet characters is not a code either.
    expect(normalizeUserCode("PQ4M-TWZ99")).toBe("");
  });

  it("drops characters the alphabet excludes rather than guessing at them", () => {
    // O/0/1/I/5/S and the vowels are not in the alphabet: dropping leaves 7 chars → incomplete,
    // and the user is told the code isn't recognized instead of a different code being sent.
    expect(normalizeUserCode("PO4M-TWZ9")).toBe("");
  });

  it("formats keystrokes into the shape the terminal printed", () => {
    expect(formatUserCodeInput("pq4m")).toBe("PQ4M");
    expect(formatUserCodeInput("pq4mt")).toBe("PQ4M-T");
    expect(formatUserCodeInput("pq4mtwz9")).toBe("PQ4M-TWZ9");
    // Overtyping past the length can't smuggle in extra characters.
    expect(formatUserCodeInput("pq4mtwz9xyz")).toBe("PQ4M-TWZ9");
  });

  it("echoes the canonical code back hyphenated, for the terminal comparison", () => {
    expect(displayUserCode("PQ4MTWZ9")).toBe("PQ4M-TWZ9");
  });
});

describe("every refusal says what happened", () => {
  const SERVER = "That login request has expired. Run the command again.";

  it("gives expired, already-used and unknown three DIFFERENT answers", () => {
    const titles = (["expired", "already_decided", "unknown"] as const).map(
      (r) => failureCopy(r, SERVER).title,
    );
    expect(new Set(titles).size).toBe(3);
    // None of them is the non-answer this screen exists to avoid.
    for (const t of titles) expect(t.toLowerCase()).not.toContain("went wrong");
  });

  it("reassures that nothing was authorized on every recoverable failure", () => {
    // "nothing NEW was authorized" for an already-decided code: it may well have been approved
    // legitimately a moment ago, and telling that user "nothing was authorized" would be false.
    for (const r of ["expired", "already_decided", "unknown"] as const) {
      expect(failureCopy(r, SERVER).body.toLowerCase()).toMatch(
        /nothing (new )?was authorized/,
      );
    }
  });

  it("offers a retry everywhere a different code could help — and not for a role refusal", () => {
    expect(failureCopy("expired", SERVER).retry).toBe(true);
    expect(failureCopy("unknown", SERVER).retry).toBe(true);
    expect(failureCopy("already_decided", SERVER).retry).toBe(true);
    expect(failureCopy("unavailable", SERVER).retry).toBe(true);
    // A different code would be refused identically — a retry button would be a lie.
    expect(failureCopy("forbidden", "Only a workspace owner…").retry).toBe(
      false,
    );
  });

  it("renders the server's own sentence for a 403, since only it knows which one fired", () => {
    const msg = "Approving a CLI login requires a signed-in user account.";
    expect(failureCopy("forbidden", msg).body).toBe(msg);
    expect(failureCopy("forbidden", msg).title).toMatch(/role/i);
  });

  it("offers the sign-in screen, not a retry, when the session died", () => {
    const c = failureCopy("session_expired", "");
    expect(c.signIn).toBe(true);
    expect(c.retry).toBe(false);
  });
});

/**
 * The refusal a PHISHING VICTIM sees.
 *
 * `POST /auth/cli/deny` is gated by the same owner/admin check as approve, so a plain member who
 * is shown a code they never generated and clicks "No — I didn't start this" also gets a 403. If
 * that state tells them to "ask an owner to approve it", the page has just instructed the victim
 * to go and get the attacker's session authorized. This is the assertion that keeps that from
 * being reintroduced.
 */
describe("a role refusal is explained in terms of the button that was pressed", () => {
  it("never suggests approving when the user tried to REFUSE", () => {
    const deny = forbiddenGuidance("deny", "Acme Production").toLowerCase();
    expect(deny).toContain("refuse");
    expect(deny).not.toContain("approve it");
    // The only reassurance available to someone who cannot act: the code dies by itself.
    expect(deny).toContain(`${CLI_CODE_WINDOW_MINUTES} minutes`);
  });

  it("does suggest finding an owner to approve when the user tried to APPROVE", () => {
    const approve = forbiddenGuidance(
      "approve",
      "Acme Production",
    ).toLowerCase();
    expect(approve).toContain("approve it");
  });

  it("names the workspace in both", () => {
    for (const d of ["approve", "deny"] as const) {
      expect(forbiddenGuidance(d, "Acme Production")).toContain(
        "Acme Production",
      );
    }
  });
});
