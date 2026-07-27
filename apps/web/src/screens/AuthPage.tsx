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
import { useAuth } from "../auth/AuthProvider";
import { setToken } from "../lib/auth";
import { redirectSignInError } from "../lib/firebase";
import { AuthScreen } from "./auth/AuthScreen";

export function AuthPage() {
  const navigate = useNavigate();
  const {
    authenticated,
    login,
    loginEmail,
    signupEmail,
    resetPassword,
    configured,
  } = useAuth();
  const [redirectError, setRedirectError] = useState<string | null>(null);

  // A redirect that FAILED (App Check refusal, an iframe that couldn't hand the credential back)
  // is otherwise perfectly silent — the SDK swallows it and returns the visitor here with no
  // session and no explanation. Surface it on the screen they land on.
  useEffect(() => {
    let live = true;
    void redirectSignInError.then((msg) => {
      if (live && msg) setRedirectError(msg);
    });
    return () => {
      live = false;
    };
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
