import "../env"; // load DATABASE_URL before @naary/db evaluates
import { ApiTokenService } from "./api-token.service";

/**
 * Bootstrap CLI to mint a tenant API token (prints the plaintext once):
 *   pnpm --filter @naary/api exec ts-node src/auth/mint-token.ts <tenantId> [label]
 */
async function main(): Promise<void> {
  const [tenantId, label = "default"] = process.argv.slice(2);
  if (!tenantId) {
    console.error("usage: ts-node src/auth/mint-token.ts <tenantId> [label]");
    process.exit(1);
  }
  const { token } = await new ApiTokenService().mint(tenantId, label);
  // eslint-disable-next-line no-console
  console.log(token);
  process.exit(0);
}

void main();
