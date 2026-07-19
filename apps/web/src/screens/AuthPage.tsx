/**
 * /auth route — thin wrapper wiring the redesigned AuthScreen (real form +
 * live browser-only workflow simulation, see screens/auth/) to the real auth
 * context: Firebase Google popup, email/password login/signup, password reset,
 * the pasted `nry_` API-token path, and the post-auth navigation into /app.
 */
import { useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider";
import { setToken } from "../lib/auth";
import { AuthScreen } from "./auth/AuthScreen";

export function AuthPage() {
  const navigate = useNavigate();
  const { login, loginEmail, signupEmail, resetPassword, configured } =
    useAuth();
  return (
    <AuthScreen
      configured={configured}
      login={login}
      loginEmail={loginEmail}
      signupEmail={signupEmail}
      resetPassword={resetPassword}
      onAuthed={() => navigate("/app")}
      onApiToken={(token) => {
        setToken(token);
        navigate("/app");
      }}
    />
  );
}
