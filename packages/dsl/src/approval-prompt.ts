/**
 * A human-approval prompt's DISPLAY text — the gate's `title` / `instructions` rendered against
 * the run they belong to (#1019).
 *
 * WHY THIS EXISTS SEPARATELY FROM `resolveTemplates`. The interpreter's resolver is built for
 * CONFIG: a reference that produced nothing becomes an empty string, because that is what the node
 * actually ran with. An approval prompt is not config, it is a SENTENCE a person reads before
 * deciding — and the two failure modes read very differently:
 *
 *   authored     "Approve the fix for issue #{{ start.issueNumber }}"
 *   config rule  "Approve the fix for issue #"          ← reads as fact; the number is simply gone
 *   this rule    "Approve the fix for issue #{{ start.issueNumber }}"  ← visibly not filled in
 *
 * A half-substituted sentence is a confident falsehood about the run; a surviving token is a
 * visible admission that something did not resolve. So a reference that resolves to `undefined` is
 * kept LITERAL here, via the resolver's own {@link KeepLiteral} extension point — the same
 * mechanism, and the same reasoning, the fix diagnosis uses for the references it declines to
 * disclose. No second copy of the `{{ }}` grammar exists here, so this cannot drift from what the
 * runtime resolves (#805).
 *
 * STRICTLY-`undefined`, matching `collectUnresolved`: a reference whose value is present but empty
 * (`null`, `""`, `0`) DID resolve, and renders as such. Only a missing one survives as a token.
 *
 * `$secrets` STAYS LITERAL — and that matters more here than anywhere else, because this text is
 * posted to Slack and Teams and put in email. It holds by construction: `resolveTemplateString`
 * short-circuits `isSecretRef` before any lookup (secret values are resolved in-activity only,
 * CLAUDE.md Tier-1 §4), so a `{{ $secrets.NAME }}` token survives even against a ctx that somehow
 * carries a `$secrets` key. `approval-prompt.spec.ts` asserts that against a ctx that DOES carry
 * one — an absent key would prove nothing, since the missing-ref rule above would keep the token
 * literal on its own and mask the real guard.
 *
 * `$vars` ARE RESOLVED. They are workspace configuration, not secrets — `$secrets` is the
 * mechanism for the other thing — and the audience is the tenant's own approver. The deciding fact
 * is local: `prepareApproval` already resolves a gate's `contextFields` against a ctx snapshot that
 * strips only `__`-prefixed keys, so `$vars` resolve there today. Those fields sit on the same
 * record, on the same screen, in the same Slack message as this title; a title that alone refused
 * to resolve `{{ $vars.REGION }}` would be incoherent, not safer. (The fix diagnosis keeps them
 * literal because its text leaves the tenant, to a model — a different boundary, not this one.)
 *
 * PURE AND TOTAL. No I/O, no clock, no randomness, and every failure path falls back to the
 * authored text — so it is safe in Temporal workflow code (Tier-1 rule 2) and an approval whose
 * ctx cannot be read still renders something a human can act on.
 */
import { getByPath } from "./mcp-args";
import { resolveTemplateString } from "./template";

/**
 * Render one prompt string against a run ctx. Never returns `undefined`, never throws, and never
 * silently drops a reference: an unresolvable `{{ x.y }}` comes back verbatim.
 *
 * Pass `{}` (or nothing) for `ctx` when the run's context cannot be read — a closed or expired run,
 * an aged-out snapshot — and the authored template is returned unchanged.
 */
export function resolvePromptText(
  text: string,
  ctx?: Record<string, unknown> | null,
): string {
  if (typeof text !== "string") return "";
  const c = ctx && typeof ctx === "object" ? ctx : {};
  let v: unknown;
  try {
    // `$secrets` is handled unconditionally INSIDE the resolver — deliberately not repeated here,
    // so the test that reverts that guard actually goes red instead of being masked by this one.
    v = resolveTemplateString(
      text,
      c,
      (ref) => getByPath(c, ref) === undefined,
    );
  } catch {
    return text; // total: an approval must stay readable whatever the ctx holds
  }
  if (typeof v === "string") return v;
  // Unreachable by construction (a whole-string token that resolved to `undefined` was kept
  // literal above), but never render the word "undefined" at a person if it ever were.
  if (v === undefined) return text;
  // Present-but-empty resolved: same as the embedded rule, which writes "" for null.
  if (v === null) return "";
  if (typeof v === "object") {
    try {
      return JSON.stringify(v) ?? text;
    } catch {
      return text; // circular — the authored text beats a crash
    }
  }
  return String(v);
}

/** The authored halves of a humanApproval gate's prompt, as the graph stores them. */
export interface ApprovalPromptText {
  title?: string;
  instructions?: string;
}

/**
 * Render a gate's whole prompt against a run ctx — the shape every surface shows (the run-detail
 * card, the approval inbox, the signed approve/reject page). Untitled gates keep the standing
 * "Approval required" default, and an instructions field that is empty AFTER resolution is null,
 * not an empty paragraph.
 */
export function resolveApprovalPrompt(
  cfg: ApprovalPromptText | null | undefined,
  ctx?: Record<string, unknown> | null,
): { title: string; instructions: string | null } {
  const c = cfg ?? {};
  const title = resolvePromptText(c.title ?? "", ctx).trim();
  const instructions = resolvePromptText(c.instructions ?? "", ctx).trim();
  return {
    title: title || "Approval required",
    instructions: instructions || null,
  };
}
