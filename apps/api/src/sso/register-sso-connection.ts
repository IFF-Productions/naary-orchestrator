import { readFileSync } from "node:fs";
import "../env"; // load DATABASE_URL before @naary/db evaluates
import { getPrisma } from "@naary/db";
import { normalizeIdpCert } from "./saml";

/**
 * OPERATOR CLI to map a workspace to a SAML IdP (design SAML-SSO.md, #455):
 *
 *   pnpm --filter @naary/api exec node -r @swc/register \
 *     src/sso/register-sso-connection.ts <tenantId> <slug> <idpEntityId> <idpSsoUrl> \
 *     <certFile> <domain[,domain…]> [role] [--no-auto-provision]
 *
 * This is the DEFAULT path for registering an IdP, because registering one declares "this
 * certificate may assert these email domains" and nothing in an HTTP request can prove the
 * registrant owns those domains (see `parseSsoSelfService` in sso-connections.controller.ts).
 * Check the domain claim, then run this. `PUT /tenants/:id/sso` does the same thing for
 * instances that explicitly set `SSO_SELF_SERVICE=true`.
 *
 * The cert is PUBLIC key material — nothing secret is printed or stored by this command.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const autoProvision = !args.includes("--no-auto-provision");
  const [tenantId, slug, idpEntityId, idpSsoUrl, certFile, domains, role] =
    args.filter((a) => !a.startsWith("--"));

  if (
    !tenantId ||
    !slug ||
    !idpEntityId ||
    !idpSsoUrl ||
    !certFile ||
    !domains
  ) {
    console.error(
      "usage: register-sso-connection.ts <tenantId> <slug> <idpEntityId> <idpSsoUrl> <certFile> <domain[,domain…]> [owner|admin|member] [--no-auto-provision]",
    );
    process.exit(1);
  }

  const allowedEmailDomains = domains
    .split(",")
    .map((d) => d.trim().toLowerCase().replace(/^@/, ""))
    .filter((d) => d.length > 0);
  if (allowedEmailDomains.length === 0) {
    console.error("At least one email domain is required.");
    process.exit(1);
  }

  // Fail here rather than at the first login if the cert file is unusable.
  const idpCertPem = normalizeIdpCert(readFileSync(certFile, "utf8"));

  const clash = await getPrisma().ssoConnection.findUnique({
    where: { idpEntityId },
  });
  if (clash && clash.tenantId !== tenantId) {
    console.error(
      `That IdP entity id is already mapped to workspace ${clash.tenantId}. An entity id maps to exactly ONE workspace.`,
    );
    process.exit(1);
  }

  const data = {
    tenantId,
    slug,
    idpEntityId,
    idpSsoUrl,
    idpCertPem,
    allowedEmailDomains,
    defaultRole:
      role && ["owner", "admin", "member"].includes(role) ? role : "member",
    autoProvision,
    enabled: true,
  };
  const row = await getPrisma().ssoConnection.upsert({
    where: { idpEntityId },
    create: data,
    update: data,
  });
  // eslint-disable-next-line no-console
  console.log(
    `registered SSO connection ${row.id} for workspace ${row.tenantId}: slug=${row.slug} domains=${allowedEmailDomains.join(",")} role=${row.defaultRole} autoProvision=${row.autoProvision}`,
  );
  process.exit(0);
}

void main();
