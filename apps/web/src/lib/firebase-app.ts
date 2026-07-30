/**
 * `initializeApp` + App Check, and DELIBERATELY nothing that touches `firebase/auth`.
 *
 * Two different surfaces need App Check, and only one of them is a sign-in:
 *   - the SPA's auth boundary (./firebase), which must have App Check running before `getAuth()`;
 *   - the PUBLIC form/chat bot gate (screens/public/BotGate), which mints a limited-use
 *     attestation token for an anonymous visitor who will never sign in.
 *
 * Before this split the bot gate reached App Check through ./firebase, so an anonymous visitor on
 * an `app_check` tenant downloaded the entire 138 KB Firebase bundle — auth SDK included — to
 * render a form. Splitting the app+App Check half off gets that path down to firebase/app +
 * firebase/app-check alone.
 *
 * THE ORDERING INVARIANT SURVIVES THE SPLIT, and does so by ES-module spec rather than by
 * convention: ./firebase imports this module, so this module's body (initializeApp, then
 * initAppCheck) is fully evaluated before `getAuth()` runs there. Attestation tokens must be
 * available to the first auth request, and auth-state restoration can fire a token refresh as
 * soon as `auth` exists. Do not invert that dependency.
 */
import { type FirebaseApp, initializeApp } from "firebase/app";
import { initAppCheck, mintBotGateToken } from "./app-check";
import { firebaseConfig, firebaseConfigured } from "./firebase-env";

// Init ONLY when configured: getAuth() with an empty apiKey throws `auth/invalid-api-key`
// synchronously at load, which would white-screen whatever imported it — including the `nry_`
// paste path. Unconfigured ⇒ the app is undefined and callers degrade to "login unavailable".
export const firebaseApp: FirebaseApp | undefined = firebaseConfigured
  ? initializeApp(firebaseConfig)
  : undefined;

// App Check BEFORE getAuth() — see the header. No-op unless VITE_FIREBASE_APPCHECK_SITE_KEY was
// set at build time; never throws (see ./app-check).
export const appCheckPlan = firebaseApp
  ? initAppCheck(firebaseApp)
  : ({ kind: "off" } as const);

/**
 * Re-exported so the public form/chat pages have ONE import that both initializes App Check
 * (that happens as a side effect of loading this module) and mints a submission token. Importing
 * ./app-check directly would compile fine and always return null, because nothing would have
 * called initAppCheck.
 */
export { mintBotGateToken };
