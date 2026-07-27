/**
 * Configuration for `@naary/secrets`. See docs/design/CONFIG-CENTRALIZATION.md (slice 3).
 *
 * Both values are KEY MATERIAL: read here, used in memory, never logged, never returned to a
 * caller that could put them in a Temporal payload or a telemetry span (CLAUDE.md Tier-1 §4).
 */

/** The master key that wraps every tenant DEK. Required — createKeyEncryptor throws without it,
 *  and both apps validate it at boot so the failure lands at startup, not on the first decrypt. */
export function encryptionKey(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return env.ENCRYPTION_KEY;
}

/**
 * Retired master keys, comma-separated, for the rotation window: DECRYPT-ONLY fallbacks so
 * ciphertext wrapped by a previous key still opens while the rewrap CLI works through the table.
 * Unset ⇒ no fallbacks, which is the steady state — a key left here after rotation completes is a
 * key that still opens data.
 */
export function oldEncryptionKeys(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  return (env.OLD_ENCRYPTION_KEY ?? "")
    .split(",")
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
}
