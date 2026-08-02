/**
 * "Where do I get this token, and what does the pasted value look like?" — resolved for one
 * provider, for the Connect dialog to render (#1063).
 *
 * CATALOG-FREE ON PURPOSE. It takes a provider OBJECT, never a key, so it imports nothing but a
 * type and can be reached from anywhere without dragging the ~161KB of `./catalog` along (the
 * same rule that moved `resolveIntegrationFields` out to `../integration-fields`).
 *
 * The interesting half is the DERIVED `tokenFormat`. Every provider already declares
 * `authScheme`, and that declaration IS the paste format — it is exactly what a user gets wrong:
 * pasting `Bearer ghp_…` into a bearer provider, or a bare Atlassian token into a Basic one. So
 * the hint is generated from it, and only providers where the generic sentence is not enough need
 * a hand-written one. An authored `tokenFormat` ALWAYS wins — the generated line is a floor, not
 * a ceiling.
 *
 * The generated Basic sentence is deliberately vague about WHICH pair. All three Basic providers
 * want a different one — Jira `email:api_token`, Twilio `AccountSid:AuthToken`, Zendesk
 * `email/token:api_token` — so a concrete generic sentence would be actively wrong for two of
 * them. Naming the halves is each provider's own job, via an authored `tokenFormat`.
 */
import type { CredentialSetup, IntegrationProvider } from "./types";

/** `CredentialSetup` with the one field that is always answerable filled in. */
export type ResolvedCredentialSetup = CredentialSetup & { tokenFormat: string };

/**
 * The paste format implied by `authScheme` alone.
 *
 * Exported for the drift guard, which asserts every one of the 38 providers produces a non-empty
 * sentence — the cheapest way to notice that a new bespoke scheme fell through to a wrong branch.
 */
export function deriveTokenFormat(p: IntegrationProvider): string {
  const scheme = p.authScheme;

  if (scheme === "basic") {
    return "Paste the whole `id:secret` pair — HTTP Basic needs both halves, and Naary base64-encodes them for you. The secret on its own returns 401.";
  }

  if (scheme === undefined || scheme === "bearer") {
    return "Paste the token on its own — `Bearer ` is added for you, so including it yourself causes a 401.";
  }

  const { header, prefix } = scheme;

  if (prefix) {
    return `Paste the token on its own — it is sent as \`${header}: ${prefix}<token>\`, so typing the \`${prefix.trim()}\` prefix yourself causes a 401.`;
  }

  if (header.toLowerCase() === "authorization") {
    return "Paste the raw token — it is the WHOLE `Authorization` header for this provider, with no `Bearer ` prefix.";
  }

  return `Paste the token on its own — it is sent in ${p.label}'s own \`${header}\` header, not as a Bearer token.`;
}

/**
 * The provider's authored setup help, with `tokenFormat` filled in when it was left off.
 *
 * Returns a value for EVERY provider (never `undefined`): even one with no authored
 * `credentialSetup` at all still has a paste format worth stating, which is the whole reason the
 * derivation exists.
 */
export function resolveCredentialSetup(
  p: IntegrationProvider,
): ResolvedCredentialSetup {
  const authored = p.credentialSetup ?? {};
  return {
    ...authored,
    // Authored wins. An author who wrote a sentence knows something the scheme cannot say.
    tokenFormat: authored.tokenFormat ?? deriveTokenFormat(p),
  };
}
