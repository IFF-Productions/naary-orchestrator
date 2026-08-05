/**
 * The `naary auth` USER CODE, client side — the short code a terminal prints and a human retypes
 * on `/app/cli-login` (#1078 §2, shape B).
 *
 * A deliberate mirror of `apps/api/src/auth/cli-auth-request.service.ts`: same alphabet, same
 * length, same canonical form. The server is still the authority — it re-normalizes whatever it
 * receives — but the browser has to answer two questions BEFORE the request goes out:
 *
 *  1. "is this code complete yet?" — which gates the Approve button. Gating on the RAW input
 *     length is wrong: `PQ4M-TWZ9` is nine characters and a pasted `pq4m twz9` is nine too, so a
 *     length check on the raw string refuses exactly the two things people actually paste.
 *  2. "what am I about to authorize?" — the page echoes the canonical hyphenated form back so the
 *     user can compare it against their terminal. That comparison is the whole anti-phishing
 *     property of a device-code flow, so the thing shown must be the thing SENT, not the
 *     keystrokes.
 *
 * Kept in `lib/` rather than inside the screen so both are testable without rendering, and so the
 * drift from the server's copy is one file to read rather than one buried in JSX.
 */

/** The server's alphabet: no vowels (a random code can't spell something unfortunate) and no
 *  `0/O/1/I/5/S` look-alikes, because this is read off a terminal and retyped by hand. */
export const USER_CODE_ALPHABET = "BCDFGHJKMNPQRTVWXYZ2346789";

export const USER_CODE_LENGTH = 8;

/**
 * Canonical form: uppercase, and everything outside the alphabet dropped. Returns `""` when the
 * result isn't exactly {@link USER_CODE_LENGTH} characters — i.e. "not a code yet", which is what
 * the button gates on.
 *
 * Note what the dropping does: the hyphen the user sees, spaces from a sloppy paste, and a
 * trailing newline from a terminal copy all disappear, so all of `PQ4M-TWZ9`, `pq4m twz9` and
 * `PQ4MTWZ9` normalize to the same code. A character the alphabet excludes (`O`, `1`, a vowel) is
 * dropped rather than corrected — the length check then fails, and the page says the code isn't
 * recognized instead of silently sending a different one.
 */
export function normalizeUserCode(raw: string | undefined): string {
  if (typeof raw !== "string") return "";
  const cleaned = raw
    .toUpperCase()
    .split("")
    .filter((c) => USER_CODE_ALPHABET.includes(c))
    .join("");
  return cleaned.length === USER_CODE_LENGTH ? cleaned : "";
}

/** Hyphenated display form — the code as the CLI prints it and the browser echoes it back. */
export function displayUserCode(canonical: string): string {
  return canonical.length === USER_CODE_LENGTH
    ? `${canonical.slice(0, 4)}-${canonical.slice(4)}`
    : canonical;
}

/**
 * Format keystrokes for the input as the user types: uppercase, alphabet-only, hyphen after the
 * fourth character. Applied on every change so what sits in the field is always the shape the
 * terminal printed — there is no moment where the field shows something the server would read
 * differently.
 */
export function formatUserCodeInput(raw: string): string {
  const cleaned = raw
    .toUpperCase()
    .split("")
    .filter((c) => USER_CODE_ALPHABET.includes(c))
    .join("")
    .slice(0, USER_CODE_LENGTH);
  return cleaned.length > 4
    ? `${cleaned.slice(0, 4)}-${cleaned.slice(4)}`
    : cleaned;
}
