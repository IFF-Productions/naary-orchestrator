/// <reference types="vite/client" />

/**
 * App Check's build-time config, declared so `import.meta.env` is assignable to the
 * narrow env type in src/lib/app-check.ts (vite/client's `ImportMetaEnv` carries no
 * index signature, so an all-optional shape trips TS's weak-type check without this).
 *
 * Only these two are declared; the rest of the VITE_* surface is still read positionally.
 * Typing all of it belongs with the env-centralization work (docs/design/CONFIG-CENTRALIZATION.md).
 */
interface ImportMetaEnv {
  /** PUBLIC reCAPTCHA site key. UNSET ⇒ App Check is not initialized. */
  readonly VITE_FIREBASE_APPCHECK_SITE_KEY?: string;
  /** Which key type the Firebase console issued: "enterprise" (default) or "v3". */
  readonly VITE_FIREBASE_APPCHECK_PROVIDER?: string;
}
