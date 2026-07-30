/**
 * The Firebase web config, read from build-time env — and NOTHING ELSE.
 *
 * Split out of ./firebase so `firebaseConfigured` can be answered WITHOUT loading the Firebase
 * SDK (#934 follow-up). AuthProvider renders on every page, including the public form/chat ones,
 * and it needs exactly one fact from Firebase at mount: whether this build has a project at all.
 * Answering that from ./firebase would statically colour all 138 KB of firebase/app +
 * firebase/auth + firebase/app-check into the eager chunk — which is the whole thing this
 * boundary exists to prevent.
 *
 * Keep this module free of any `firebase/*` import. It is on the critical path by design; every
 * other Firebase module is behind the dynamic import in ./firebase-lazy.
 *
 * The values are public (Firebase API keys are not secrets — access is enforced by Firebase
 * security rules + the backend verifying the ID token), but we still keep them OUT of source:
 * all come from VITE_FIREBASE_* env, injected at build time (see docker-compose web build-args /
 * .env.example).
 */
export const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

/**
 * True when the build was given a Firebase project (else login is unavailable; the `nry_` token
 * paste still works).
 *
 * Load-bearing for the boundary as well as the UI: AuthProvider uses it to skip activation
 * entirely on an unconfigured build, so a self-hosted install never fetches the auth chunk.
 */
export const firebaseConfigured = Boolean(firebaseConfig.apiKey);
