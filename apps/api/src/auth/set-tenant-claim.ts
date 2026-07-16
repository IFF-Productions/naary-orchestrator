import {
  applicationDefault,
  cert,
  getApps,
  initializeApp,
} from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

/**
 * Provisioning CLI: assign a tenant to a Firebase user by setting the `tenant`
 * custom claim the AuthGuard authorizes on. Mirrors mint-token.ts (the API-token
 * path). Requires a service account (FIREBASE_SERVICE_ACCOUNT_JSON inline, or
 * GOOGLE_APPLICATION_CREDENTIALS pointing at the key file) — the same credential
 * the API uses to verify ID tokens.
 *
 *   node -r @swc/register src/auth/set-tenant-claim.ts <firebaseUid> <tenantId>
 *
 * The user must obtain a fresh ID token after this (sign out/in or force-refresh)
 * for the new claim to appear in the token.
 */
async function main(): Promise<void> {
  const [uid, tenantId] = process.argv.slice(2);
  if (!uid || !tenantId) {
    console.error(
      "usage: node -r @swc/register src/auth/set-tenant-claim.ts <uid> <tenantId>",
    );
    process.exit(1);
  }

  const json = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!json && !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    console.error(
      "Set FIREBASE_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS first.",
    );
    process.exit(1);
  }

  if (getApps().length === 0) {
    initializeApp({
      credential: json ? cert(JSON.parse(json)) : applicationDefault(),
      ...(process.env.FIREBASE_PROJECT_ID
        ? { projectId: process.env.FIREBASE_PROJECT_ID }
        : {}),
    });
  }

  // Merge with any existing claims so we don't clobber other custom claims.
  const auth = getAuth();
  const user = await auth.getUser(uid);
  await auth.setCustomUserClaims(uid, {
    ...(user.customClaims ?? {}),
    tenant: tenantId,
  });
  console.log(`Set tenant='${tenantId}' on user ${uid}.`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
