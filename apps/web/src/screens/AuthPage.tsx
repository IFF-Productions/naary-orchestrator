import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider";
import { Button, Field, Icon, Logo, TextInput } from "../components";
import { setToken } from "../lib/auth";

type Mode = "login" | "signup";

const COPY: Record<
  Mode,
  {
    title: string;
    subtitle: string;
    cta: string;
    switchPrompt: string;
    switchAction: string;
  }
> = {
  login: {
    title: "Welcome back",
    subtitle: "Sign in to continue to your Naary workspace.",
    cta: "Sign in",
    switchPrompt: "New to Naary?",
    switchAction: "Create an account",
  },
  signup: {
    title: "Create your account",
    subtitle: "Start orchestrating durable agent workflows.",
    cta: "Create account",
    switchPrompt: "Already have an account?",
    switchAction: "Sign in",
  },
};

const stats = [
  { value: "99.98%", label: "control-plane uptime" },
  { value: "30d", label: "max single run" },
  { value: "SOC 2", label: "Type II" },
];

export function AuthPage() {
  const navigate = useNavigate();
  const { login, loginEmail, signupEmail, configured } = useAuth();
  const [mode, setMode] = useState<Mode>("login");
  const [showPassword, setShowPassword] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [apiToken, setApiToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const copy = COPY[mode];

  // Email/password via Firebase. On success, onAuthStateChanged flips the session
  // and RequireAuth lets /app render. The pasted `nry_` token is the secondary
  // path (no Firebase needed): store it and enter directly.
  async function submit(): Promise<void> {
    setError(null);
    if (apiToken.trim()) {
      setToken(apiToken);
      navigate("/app");
      return;
    }
    if (!email.trim() || !password) {
      setError("Enter your email and password, or paste an API token.");
      return;
    }
    setBusy(true);
    try {
      if (mode === "signup") await signupEmail(email.trim(), password);
      else await loginEmail(email.trim(), password);
      navigate("/app");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Authentication failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        display: "flex",
        height: "100vh",
        background: "var(--bg)",
        color: "var(--ink)",
        fontFamily: "var(--font-sans)",
        overflow: "hidden",
      }}
    >
      {/* ------------------------------ LEFT brand panel ------------------------------ */}
      <div
        style={{
          position: "relative",
          width: 620,
          flex: "none",
          background: "var(--bg-2)",
          borderRight: "1px solid var(--line)",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          padding: "44px 56px",
        }}
      >
        {/* ember radial glows */}
        <div
          aria-hidden
          style={{
            position: "absolute",
            top: -160,
            left: -120,
            width: 520,
            height: 520,
            borderRadius: "50%",
            background:
              "radial-gradient(circle, rgba(242,98,46,0.28), rgba(242,98,46,0) 68%)",
            filter: "blur(8px)",
            pointerEvents: "none",
          }}
        />
        <div
          aria-hidden
          style={{
            position: "absolute",
            bottom: -200,
            right: -140,
            width: 560,
            height: 560,
            borderRadius: "50%",
            background:
              "radial-gradient(circle, rgba(200,51,31,0.22), rgba(200,51,31,0) 70%)",
            filter: "blur(8px)",
            pointerEvents: "none",
          }}
        />
        <div
          aria-hidden
          style={{
            position: "absolute",
            top: "42%",
            left: "30%",
            width: 320,
            height: 320,
            borderRadius: "50%",
            background:
              "radial-gradient(circle, rgba(255,138,76,0.14), rgba(255,138,76,0) 72%)",
            filter: "blur(6px)",
            pointerEvents: "none",
          }}
        />

        {/* wordmark */}
        <div
          style={{
            position: "relative",
            display: "flex",
            alignItems: "center",
            gap: 12,
          }}
        >
          <Logo size={34} />
          <span
            style={{ fontSize: 19, fontWeight: 700, letterSpacing: "-0.01em" }}
          >
            Naary
          </span>
        </div>

        {/* headline + subtext */}
        <div
          style={{
            position: "relative",
            flex: 1,
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
          }}
        >
          <h1
            style={{
              fontSize: 40,
              lineHeight: 1.12,
              fontWeight: 700,
              letterSpacing: "-0.02em",
              margin: 0,
              maxWidth: 460,
            }}
          >
            Orchestrate agents that run for days, not seconds.
          </h1>
          <p
            style={{
              fontSize: 15,
              lineHeight: 1.6,
              color: "var(--ink-2)",
              marginTop: 18,
              maxWidth: 420,
            }}
          >
            Durable, human-in-the-loop AI workflows that survive crashes, pause
            for approvals, and pick up exactly where they left off.
          </p>

          {/* stat row */}
          <div style={{ display: "flex", gap: 38, marginTop: 44 }}>
            {stats.map((s) => (
              <div key={s.value}>
                <div
                  className="mono"
                  style={{
                    fontSize: 22,
                    fontWeight: 600,
                    letterSpacing: "-0.01em",
                  }}
                >
                  {s.value}
                </div>
                <div
                  style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 4 }}
                >
                  {s.label}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* status footer */}
        <div
          style={{
            position: "relative",
            display: "flex",
            alignItems: "center",
            gap: 9,
            fontSize: 12,
            color: "var(--ink-2)",
          }}
        >
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: "var(--state-done)",
              boxShadow: "0 0 8px var(--state-done)",
              flex: "none",
            }}
          />
          All systems operational
          <span style={{ color: "var(--ink-3)" }}>· status.naary.dev</span>
        </div>
      </div>

      {/* ------------------------------ RIGHT form panel ------------------------------ */}
      <div
        style={{
          flex: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 40,
        }}
      >
        <div style={{ width: 380, maxWidth: "100%" }}>
          <h2
            style={{
              fontSize: 26,
              fontWeight: 700,
              letterSpacing: "-0.02em",
              margin: 0,
            }}
          >
            {copy.title}
          </h2>
          <p
            style={{
              fontSize: 13.5,
              color: "var(--ink-2)",
              marginTop: 8,
              marginBottom: 26,
            }}
          >
            {copy.subtitle}
          </p>

          {/* primary: real Firebase Google sign-in (popup). Disabled when the build
              has no Firebase config — then only the `nry_` token paste works. */}
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <Button
              variant="secondary"
              block
              disabled={!configured || busy}
              onClick={async () => {
                setError(null);
                try {
                  await login();
                  navigate("/app");
                } catch (e) {
                  setError(
                    e instanceof Error ? e.message : "Google sign-in failed.",
                  );
                }
              }}
            >
              <GoogleGlyph />
              Continue with Google
            </Button>
            {!configured && (
              <div style={{ fontSize: 11.5, color: "var(--ink-3)" }}>
                Firebase login isn’t configured for this build — paste an API
                token below to continue.
              </div>
            )}
          </div>

          {/* divider */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              margin: "22px 0",
            }}
          >
            <span style={{ flex: 1, height: 1, background: "var(--line)" }} />
            <span style={{ fontSize: 11, color: "var(--ink-3)" }}>or</span>
            <span style={{ flex: 1, height: 1, background: "var(--line)" }} />
          </div>

          {/* form fields */}
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            {mode === "signup" && (
              <Field label="Full name">
                <TextInput
                  type="text"
                  placeholder="Ada Lovelace"
                  autoComplete="name"
                />
              </Field>
            )}

            <Field label="Work email">
              <TextInput
                className="focused"
                type="email"
                placeholder="you@company.com"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </Field>

            <Field
              label="Password"
              hint={
                mode === "login" ? (
                  <a
                    href="#"
                    onClick={(e) => e.preventDefault()}
                    style={{
                      fontSize: 12,
                      color: "var(--ink-2)",
                      textDecoration: "none",
                    }}
                  >
                    Forgot?
                  </a>
                ) : undefined
              }
            >
              <div style={{ position: "relative" }}>
                <TextInput
                  type={showPassword ? "text" : "password"}
                  placeholder="••••••••••"
                  autoComplete={
                    mode === "login" ? "current-password" : "new-password"
                  }
                  style={{ paddingRight: 38 }}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
                <button
                  type="button"
                  aria-label={showPassword ? "Hide password" : "Show password"}
                  onClick={() => setShowPassword((v) => !v)}
                  style={{
                    position: "absolute",
                    top: 0,
                    right: 0,
                    height: "100%",
                    width: 38,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    background: "transparent",
                    border: "none",
                    cursor: "pointer",
                    color: "var(--ink-3)",
                    padding: 0,
                  }}
                >
                  <Icon name="eye" size={16} />
                </button>
              </div>
            </Field>
          </div>

          {/* API token — optional; enables live control-plane calls */}
          <div style={{ marginTop: 13 }}>
            <Field label="API token (optional — enables live runs)">
              <TextInput
                placeholder="nry_…  (paste a minted token)"
                value={apiToken}
                onChange={(e) => setApiToken(e.target.value)}
                spellCheck={false}
                autoComplete="off"
              />
            </Field>
          </div>

          {/* submit */}
          {error && (
            <div
              style={{
                marginTop: 16,
                fontSize: 12.5,
                color: "var(--state-error)",
              }}
            >
              {error}
            </div>
          )}
          <div style={{ marginTop: 22 }}>
            <Button
              variant="primary"
              block
              iconRight="arrow-right"
              disabled={busy}
              onClick={() => void submit()}
            >
              {busy ? "…" : copy.cta}
            </Button>
          </div>

          {/* switch login/signup */}
          <div
            style={{
              marginTop: 22,
              textAlign: "center",
              fontSize: 13,
              color: "var(--ink-2)",
            }}
          >
            {copy.switchPrompt}{" "}
            <button
              type="button"
              onClick={() => setMode(mode === "login" ? "signup" : "login")}
              style={{
                background: "none",
                border: "none",
                padding: 0,
                cursor: "pointer",
                color: "var(--brand)",
                fontWeight: 600,
                fontFamily: "inherit",
                fontSize: 13,
              }}
            >
              {copy.switchAction}
            </button>
          </div>

          {/* terms footer */}
          <p
            style={{
              marginTop: 28,
              fontSize: 11.5,
              lineHeight: 1.6,
              color: "var(--ink-3)",
              textAlign: "center",
            }}
          >
            By continuing you agree to Naary&rsquo;s{" "}
            <a
              href="#"
              onClick={(e) => e.preventDefault()}
              style={{ color: "var(--ink-2)" }}
            >
              Terms
            </a>{" "}
            and{" "}
            <a
              href="#"
              onClick={(e) => e.preventDefault()}
              style={{ color: "var(--ink-2)" }}
            >
              Privacy Policy
            </a>
            .
          </p>
        </div>
      </div>
    </div>
  );
}

/* ---------------- Brand glyphs (not part of the line-icon set) ---------------- */
function GoogleGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden="true">
      <path
        fill="#FFC107"
        d="M43.611 20.083H42V20H24v8h11.303c-1.649 4.657-6.08 8-11.303 8-6.627 0-12-5.373-12-12s5.373-12 12-12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 12.955 4 4 12.955 4 24s8.955 20 20 20 20-8.955 20-20c0-1.341-.138-2.65-.389-3.917z"
      />
      <path
        fill="#FF3D00"
        d="M6.306 14.691l6.571 4.819C14.655 15.108 18.961 12 24 12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 16.318 4 9.656 8.337 6.306 14.691z"
      />
      <path
        fill="#4CAF50"
        d="M24 44c5.166 0 9.86-1.977 13.409-5.192l-6.19-5.238C29.211 35.091 26.715 36 24 36c-5.202 0-9.619-3.317-11.283-7.946l-6.522 5.025C9.505 39.556 16.227 44 24 44z"
      />
      <path
        fill="#1976D2"
        d="M43.611 20.083H42V20H24v8h11.303c-.792 2.237-2.231 4.166-4.087 5.571.001-.001.002-.001.003-.002l6.19 5.238C36.971 39.205 44 34 44 24c0-1.341-.138-2.65-.389-3.917z"
      />
    </svg>
  );
}
