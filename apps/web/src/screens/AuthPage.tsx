/**
 * /auth route — thin wrapper wiring the redesigned AuthScreen (real form +
 * live browser-only workflow simulation, see screens/auth/) to the real auth
 * context: Firebase Google popup, email/password login/signup, password reset,
 * the pasted `nry_` API-token path, and the post-auth navigation into /app.
 *
 * TWO WAYS OUT OF HERE, and for a long time only one existed. The popup and email paths resolve a
 * promise, so AuthScreen calls `onAuthed` and we navigate. The REDIRECT path (added when a blocked
 * popup started falling back to `signInWithRedirect`) cannot: the visitor comes back on a fresh
 * page load, with no promise and no callback — just a restored session arriving asynchronously
 * through `onAuthStateChanged`. With nothing watching `authenticated`, a completely successful
 * Google sign-in landed the visitor right back on the sign-in form. Hence the <Navigate> below;
 * it also covers a signed-in visitor who simply types /auth.
 */
import { useEffect, useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { useAuthSession } from "../auth/AuthProvider";
import { setToken } from "../lib/auth";
import { takeRedirectSignInError } from "../lib/firebase-lazy";
import { AuthScreen } from "./auth/AuthScreen";

export function AuthPage() {
  const navigate = useNavigate();
  // useAuthSession: mounting the sign-in screen is a declaration that this page needs Firebase,
  // so it activates the async boundary (lib/firebase-lazy). The /auth route's loader has usually
  // started that fetch already — in parallel with this chunk — which is what keeps the Google
  // button's click path synchronous all the way to signInWithPopup (#800).
  const {
    authenticated,
    login,
    loginEmail,
    signupEmail,
    resetPassword,
    configured,
  } = useAuthSession();
  const [redirectError, setRedirectError] = useState<string | null>(null);

  // A redirect that FAILED (App Check refusal, an iframe that couldn't hand the credential back)
  // is otherwise perfectly silent — the SDK swallows it and returns the visitor here with no
  // session and no explanation. Surface it on the screen they land on.
  //
  // NO is-mounted GUARD, on purpose. The message is one-shot, and under StrictMode dev double-
  // invoke the sequence is: effect #1 takes it (burning the shot) → cleanup #1 → effect #2 gets
  // null. A `live` flag would then make effect #1's resolution discard the only copy, so the
  // diagnostic would never appear in development — the one place we most need to see it. Setting
  // state after unmount is a no-op in React 18+, not the leak the old warning implied.
  //
  // The rejection arm is NOT optional now that this crosses the async auth boundary. It used to
  // read a promise from an already-loaded module and could only settle one way; it now awaits a
  // dynamic import, which rejects when a cached client's chunk is gone after a deploy (#603's
  // exact scenario). Unhandled, that becomes a Sentry report via lib/sentry-rejections for a
  // condition `vite:preloadError` already handles by reloading. Swallow it: there is no redirect
  // diagnostic to show if the module carrying it never arrived.
  useEffect(() => {
    void takeRedirectSignInError().then(
      (msg) => {
        if (msg) setRedirectError(msg);
      },
      () => undefined,
    );
  }, []);

  // Already signed in — including the moment `onAuthStateChanged` restores the session after a
  // redirect return. `replace` so Back doesn't bounce off the sign-in screen again.
  if (authenticated) return <Navigate to="/app" replace />;

  return (
    <AuthScreen
      configured={configured}
      login={login}
      loginEmail={loginEmail}
      signupEmail={signupEmail}
      resetPassword={resetPassword}
      initialError={redirectError}
      onAuthed={() => navigate("/app")}
      onApiToken={(token) => {
        setToken(token);
        navigate("/app");
      }}
    />
  );
}
