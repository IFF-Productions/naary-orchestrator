/**
 * PURE mapping from a picked CATALOG PROVIDER to the connect form's initial values.
 *
 * Asked for as: "every time we add an integration (e.g. PagerDuty) we should prepopulate the field
 * with basic stuff like the api endpoint, or the authentication type", and "instead of generic, we
 * should be more concise about the auth type".
 *
 * Every fact here already exists in `@naary/dsl`'s catalog — the endpoint, the header, the prefix,
 * the prose. It was simply never reachable from the form where you need it: #815 was filed because
 * connecting PagerDuty meant knowing to pick "Custom", knowing the base URL, and knowing the token
 * goes in raw. #838 surfaced the prose as a hint; this removes the guesswork instead of explaining
 * it.
 *
 * Kept out of the component and free of runtime React imports so it can be unit-tested in the web
 * suite's node environment — same shape as `mcp-registry-prefill.ts`.
 */
import { getIntegrationProvider, INTEGRATION_PROVIDERS } from "@naary/dsl";

export interface CatalogConnectPrefill {
  /** Provider label, used as the connection's default name ("PagerDuty"). */
  label: string;
  /** The catalog's base URL, or "" when the host belongs to the tenant. */
  serverUrl: string;
  /** What to put in Server URL, in words — differs per provider, so it can't be a placeholder. */
  serverUrlHint: string;
  /** Catalog providers are all `custom` connections; github/atlassian are their own OAuth apps. */
  type: "custom";
  authMode: "api_token";
  /**
   * The EXACT header the request will carry — `Authorization: Token token=<your key>` — instead of
   * the form's generic `api_token`. This is the line that tells you whether your token is right.
   */
  authHeader: string;
  /** The catalog's own prose: where the credential comes from and any per-provider caveat. */
  authNote: string;
  /** True when Server URL is the real API host (a Jira site, a Shopify store) and not a label. */
  hostFromConnection: boolean;
}

/** Every provider the picker offers, in catalog order. */
export function connectableProviders(): { key: string; label: string }[] {
  return INTEGRATION_PROVIDERS.map((p) => ({ key: p.key, label: p.label }));
}

/**
 * Describe the auth header precisely.
 *
 * The catalog stores this three ways, and all three appear in practice: a plain bearer (29
 * providers), HTTP Basic (twilio/zendesk/jira), and a bespoke header or prefix (PagerDuty's
 * `Token token=`, DeepL's `DeepL-Auth-Key `, Shopify's `X-Shopify-Access-Token`, Discord's `Bot `).
 * Collapsing those to "api_token" is what made the form unhelpful.
 */
function describeAuthHeader(
  scheme: ReturnType<typeof getIntegrationProvider> extends undefined
    ? never
    : NonNullable<ReturnType<typeof getIntegrationProvider>>["authScheme"],
): string {
  if (scheme === "basic")
    return "Authorization: Basic <base64 of your token> — the token is base64-encoded for you";
  if (scheme === undefined || scheme === "bearer")
    return "Authorization: Bearer <your token>";
  const prefix = scheme.prefix ?? "";
  return `${scheme.header}: ${prefix}<your token>`;
}

/** `undefined` when the key isn't a catalog provider (the caller keeps its manual form). */
export function catalogConnectPrefill(
  providerKey: string,
): CatalogConnectPrefill | undefined {
  const provider = getIntegrationProvider(providerKey);
  if (!provider) return undefined;

  const hostFromConnection = !!provider.baseUrlFromConnection;

  return {
    label: provider.label,
    // For a per-tenant host there is nothing to prefill — the value is the user's own site, and
    // guessing one would be worse than leaving it blank.
    serverUrl: hostFromConnection ? "" : (provider.baseUrl ?? ""),
    serverUrlHint: hostFromConnection
      ? `Your own ${provider.label} host — this IS the address every call goes to.`
      : provider.baseUrl
        ? `Prefilled from the catalog. ${provider.label} calls go to this host regardless, so it is only a label here.`
        : "Any https URL — a label only for this provider.",
    type: "custom",
    // Connections have one token-shaped mode; the SCHEME (bearer/basic/custom header) is applied
    // by the request builder, which is why `authHeader` below is the useful thing to show.
    authMode: "api_token",
    authHeader: describeAuthHeader(provider.authScheme),
    authNote: provider.auth,
    hostFromConnection,
  };
}
