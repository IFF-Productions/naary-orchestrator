/**
 * Shown when a signed-in user is rejected by the server's access allowlist
 * (ACCESS_ALLOWED_EMAILS — early-access lockdown). They're authenticated, just not enabled.
 * Offers a sign-out so a different account can be used. Public ingress (webhooks/forms) is
 * unaffected — this only gates the operator UI.
 */
import { useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider";
import { Button, Icon } from "../components";
import { clearToken } from "../lib/auth";

export function NotAvailable() {
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
          maxWidth: 440,
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
          <Icon name="flame" size={24} style={{ color: "var(--brand-ink)" }} />
        </div>

        <div
          style={{
            fontSize: "var(--text-title)",
            fontWeight: "var(--weight-bold)",
            color: "var(--ink)",
            letterSpacing: "-0.01em",
          }}
        >
          Naary is in early access
        </div>
        <p
          style={{
            fontSize: "var(--text-body)",
            color: "var(--ink-2)",
            lineHeight: "var(--leading-normal)",
            marginTop: 10,
          }}
        >
          Your account isn't enabled to use Naary yet. If you think this is a
          mistake, reach out to the workspace owner.
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
