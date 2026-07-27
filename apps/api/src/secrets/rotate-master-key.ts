import "../env"; // load DATABASE_URL before @naary/db evaluates
import { rotateMasterKey } from "@naary/secrets";
import { encryptionKey } from "../config";

/**
 * Ops CLI: rotate the master ENCRYPTION_KEY (envelope rewrap). Zero-downtime runbook:
 *
 *  1. Set ENCRYPTION_KEY=<new 64-hex> and OLD_ENCRYPTION_KEY=<old> in .env and
 *     restart api + worker — everything old still decrypts via the fallback chain
 *     (FallbackKeyEncryptor), while new writes already use the new key.
 *  2. Preview, then run the rewrap:
 *       pnpm --filter @naary/api exec node -r @swc/register src/secrets/rotate-master-key.ts --dry-run
 *       pnpm --filter @naary/api exec node -r @swc/register src/secrets/rotate-master-key.ts
 *     (re-wraps every tenant DEK under the new master, and converges legacy
 *     master-encrypted rows — credentials + webhook signing secrets — to the
 *     tenant-DEK v3 format).
 *  3. On a clean report, remove OLD_ENCRYPTION_KEY from .env and restart.
 *
 * Prints counts and per-row failures (ids + error NAMES only — never key material).
 * Exits non-zero if any row failed, so a wrapper/runbook can catch a partial sweep.
 */
async function main(): Promise<void> {
  if (!encryptionKey()) {
    console.error("ENCRYPTION_KEY (the NEW master) is required.");
    process.exit(1);
  }
  const dryRun = process.argv.includes("--dry-run");
  const res = await rotateMasterKey({ dryRun });
  const verb = dryRun ? "would rewrap" : "rewrapped";
  console.log(
    `${verb}: ${res.tenantKeysRewrapped} tenant DEK(s), ` +
      `${res.credentialsConverged} legacy credential row(s) → v3, ` +
      `${res.webhookSecretsConverged} webhook secret(s) → v3`,
  );
  for (const f of res.failures) {
    console.error(`FAILED ${f.table} ${f.id}: ${f.errorName}`);
  }
  if (res.failures.length > 0) {
    console.error(
      `${res.failures.length} row(s) failed — keep OLD_ENCRYPTION_KEY set and investigate before dropping it.`,
    );
    process.exit(1);
  }
  process.exit(0);
}

void main();
