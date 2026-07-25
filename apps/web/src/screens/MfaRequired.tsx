/**
 * Shown when the instance requires two-factor authentication (`REQUIRE_MFA`, #457) and this
 * session signed in with a single factor: the API answered 403 `mfa_required`. They're
 * authenticated — just not with a second factor — so this is a distinct gated state, not a
 * generic "forbidden".
 *
 * Enrolment itself is a FIREBASE, client-side flow (`multiFactor(user).enroll(...)` after a
 * fresh re-authentication), and it is NOT wired into this build — see
 * docs/design/MFA-ENFORCEMENT.md ("deferred"). This screen is the documented entry point:
 * it tells the user exactly what has to happen and gives them a clean way back to the sign-in
 * screen once a factor is enrolled. Nothing here can bypass the gate — the server decides.
 *
 * NB: a second factor is stamped into the ID TOKEN at sign-in, so enrolling is not enough on
 * its own — the user must sign in again to get a token that carries the claim. Hence the
 * primary action is "Sign out", not "Retry".
 */
import { useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider";
import { Button, Icon } from "../components";
import { clearToken } from "../lib/auth";

export function MfaRequired() {
  const { email, logout } = useAuth();
  const navigate = useNavigate();

  function signOut() {
    logout();
    clearToken();
    navigate("/auth");
  }

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "var(--bg)",
        padding: 24,
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: 460,
          textAlign: "center",
          background: "var(--card)",
          border: "1px solid var(--line)",
          borderRadius: "var(--radius-lg)",
          boxShadow: "var(--shadow-card)",
          padding: "36px 32px",
        }}
      >
        <div
          style={{
            width: 46,
            height: 46,
            margin: "0 auto 18px",
            borderRadius: "var(--radius-md)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "var(--brand-radial)",
            boxShadow: "var(--glow-brand)",
          }}
        >
          <Icon name="key" size={24} style={{ color: "var(--brand-ink)" }} />
        </div>

        <div
          style={{
            fontSize: "var(--text-title)",
            fontWeight: "var(--weight-bold)",
            color: "var(--ink)",
            letterSpacing: "-0.01em",
          }}
        >
          Two-factor authentication required
        </div>
        <p
          style={{
            fontSize: "var(--text-body)",
            color: "var(--ink-2)",
            lineHeight: "var(--leading-normal)",
            marginTop: 10,
          }}
        >
          This Naary instance requires a second factor to sign in. Enrol one on
          your account, then sign in again — your new session will carry the
          second factor and this screen will go away.
        </p>
        <p
          style={{
            fontSize: "var(--text-xs)",
            color: "var(--ink-3)",
            lineHeight: "var(--leading-normal)",
            marginTop: 10,
          }}
        >
          Enrolment is handled by your identity provider (Firebase
          Authentication). If you don't have a way to enrol yet, ask the person
          who runs this instance — they can enable a second-factor method, or
          turn the requirement off.
        </p>

        {email && (
          <div
            className="mono"
            style={{
              fontSize: "var(--text-xs)",
              color: "var(--ink-3)",
              background: "var(--surface)",
              border: "1px solid var(--line)",
              borderRadius: "var(--radius-sm)",
              padding: "7px 10px",
              margin: "18px 0 22px",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            Signed in as {email}
          </div>
        )}

        <Button
          variant="secondary"
          icon="logout"
          block
          onClick={signOut}
          style={{ marginTop: email ? 0 : 22 }}
        >
          Sign out
        </Button>
      </div>
    </div>
  );
}
