import "../env"; // load DATABASE_URL before @naary/db evaluates
import { ScimConnectionService } from "./scim-connection.service";

/**
 * OPERATOR CLI to authorise a customer IdP to sync ONE workspace over SCIM (#1075):
 *
 *   pnpm --filter @naary/api exec node -r @swc/register \
 *     src/scim/register-scim-connection.ts <tenantId> <label> <domain[,domain…]>
 *
 * This is the ONLY path — there is no HTTP route that mints one, not even behind a
 * self-service flag. Registering a connection declares "this IdP may read, and from slice 2
 * provision and de-provision, this workspace's directory", and nothing in an HTTP request
 * proves the registrant owns the domains they name. That is the SAML posture exactly
 * (`register-sso-connection.ts`, `SSO_SELF_SERVICE` defaulting off), and de-provisioning
 * makes the stakes higher here than there: a hostile or simply mis-scoped connection is a
 * denial-of-service against a workspace's own members.
 *
 * The plaintext bearer is printed ONCE, to this terminal, and is not recoverable afterwards
 * — only its sha256 is stored. Hand it to the IdP admin over a channel you trust.
 */
async function main(): Promise<void> {
  const [tenantId, label, domains] = process.argv.slice(2);
  if (!tenantId || !label || !domains) {
    console.error(
      "usage: register-scim-connection.ts <tenantId> <label> <domain[,domain…]>",
    );
    process.exit(1);
  }

  const list = domains.split(",");
  let minted: { id: string; token: string; tenantId: string; label: string };
  try {
    minted = await new ScimConnectionService().mint(tenantId, label, list);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  // eslint-disable-next-line no-console
  console.log(
    [
      `registered SCIM connection ${minted.id} for workspace ${minted.tenantId} (${minted.label})`,
      "",
      "  SCIM base URL:  <your-public-base>/scim/v2",
      `  Bearer token:   ${minted.token}`,
      "",
      "Shown ONCE — only the sha256 is stored. Re-run this command to issue a new one.",
      "This slice is READ ONLY: the IdP can list and fetch users, and cannot create,",
      "modify or de-provision anyone.",
    ].join("\n"),
  );
  process.exit(0);
}

void main();
