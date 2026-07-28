/**
 * Auth screen (redesign). RIGHT: the real sign-in/sign-up form — Firebase
 * Google popup + email/password + password reset, plus the secondary pasted
 * `nry_` API-token path and the Firebase-not-configured fallback. LEFT: a
 * browser-only workflow simulation (WorkflowSimulation) whose node states are
 * driven by the REAL form state, and whose staged run is synchronized with the
 * REAL auth promise: submit starts verify → paused → provision, "done" only
 * lands when the promise resolves, and a rejection stops the run and shows the
 * honest failure. No backend calls beyond the real auth.
 *
 * Auth calls arrive as props (wired by AuthPage) so Storybook can stand in
 * timed fakes. Dark-only by design — the comp hardcodes the dark palette, so
 * this screen paints its own dark surfaces in both themes.
 */
import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { Logo } from "../../components";
import "./auth.css";
import { WorkflowSimulation } from "./WorkflowSimulation";
import { authErrorMessage, withAppCheckHint } from "../../lib/auth-errors";
import { appCheckAttestationFailed } from "../../lib/app-check";
import {
  type AuthMode,
  type FocusField,
  type Provider,
  type SimulationSignals,
  type Stage,
  isFormReady,
} from "./simulation";

export interface AuthScreenProps {
  /** Whether a Firebase web config exists (else only the token paste works). */
  configured: boolean;
  /** Real Google popup sign-in. */
  login: () => Promise<void>;
  loginEmail: (email: string, password: string) => Promise<void>;
  signupEmail: (
    email: string,
    password: string,
    fullName?: string,
  ) => Promise<void>;
  resetPassword: (email: string) => Promise<void>;
  /** Post-auth navigation (kept from the previous screen: → /app). */
  onAuthed: () => void;
  /** The pasted `nry_` token path: store it and enter directly. */
  onApiToken: (token: string) => void;
  initialMode?: AuthMode;
  /**
   * An error to show on arrival, for a failure that happened while this screen wasn't mounted —
   * today that means a `signInWithRedirect` return leg that failed (AuthPage). Applied when it
   * appears, not just at mount, because it resolves from a promise a tick or two after first paint.
   */
  initialError?: string | null;
}

const COPY: Record<
  AuthMode,
  {
    title: string;
    subtitle: string;
    cta: string;
    ctaDone: string;
    switchPrompt: string;
    switchAction: string;
  }
> = {
  login: {
    title: "Sign in to Naary",
    subtitle: "Fill the form — watch the run advance on the left.",
    cta: "Sign in",
    ctaDone: "Signed in",
    switchPrompt: "Don’t have an account?",
    switchAction: "Sign up",
  },
  signup: {
    title: "Create your workspace",
    subtitle: "Fill the form — watch provisioning advance on the left.",
    cta: "Create account",
    ctaDone: "Account created",
    switchPrompt: "Already have an account?",
    switchAction: "Sign in",
  },
};

const labelStyle: CSSProperties = {
  fontSize: 11.5,
  color: "#98a2b3",
  marginBottom: 6,
};

const inputStyle = (focused: boolean, height = 42): CSSProperties => ({
  width: "100%",
  height,
  background: "#12151c",
  border: `1px solid ${focused ? "#f2622e" : "#2c3542"}`,
  borderRadius: 9,
  padding: "0 13px",
  fontSize: 13,
  color: "#e8ebf1",
  outline: "none",
  boxShadow: focused ? "0 0 0 3px rgba(242,98,46,.13)" : "none",
  transition: "border-color .2s, box-shadow .2s",
  fontFamily: "inherit",
});

const linkButtonStyle: CSSProperties = {
  background: "none",
  border: "none",
  padding: 0,
  color: "#f2622e",
  fontWeight: 600,
  cursor: "pointer",
  fontFamily: "inherit",
};

export function AuthScreen({
  configured,
  login,
  loginEmail,
  signupEmail,
  resetPassword,
  onAuthed,
  onApiToken,
  initialMode = "login",
  initialError = null,
}: AuthScreenProps) {
  const [mode, setMode] = useState<AuthMode>(initialMode);
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [focus, setFocus] = useState<FocusField>("");
  const [apiToken, setApiToken] = useState("");
  // The `nry_` paste path stays reachable behind a small affordance; opened by
  // default when Firebase isn't configured (then it's the only way in).
  const [tokenOpen, setTokenOpen] = useState(!configured);
  const [tokenFocus, setTokenFocus] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [stage, setStage] = useState<Stage>(null);
  const [provider, setProvider] = useState<Provider>(null);
  const [viewport, setViewport] = useState<[number, number]>(() => [
    window.innerWidth,
    window.innerHeight,
  ]);

  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  // Gate for the email path: "done" needs BOTH the staged animation to finish
  // AND the real auth promise to resolve — the sim never fakes success.
  const gate = useRef({ seqDone: false, authOk: false, finished: false });

  // Arrives asynchronously (a promise resolved after first paint), so this can't be seeded into
  // useState. Only ever SETS: a live attempt's own failure must not be clobbered by a stale one,
  // and submit() already clears `error` before each attempt.
  useEffect(() => {
    // Functional update: never clobber an error already on screen. This resolves from a promise a
    // tick or two after first paint, and a visitor who has already started a new attempt in that
    // window must see THAT attempt's failure, not the previous page load's.
    if (initialError) setError((current) => current ?? initialError);
  }, [initialError]);

  useEffect(() => {
    const onResize = () => setViewport([window.innerWidth, window.innerHeight]);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      for (const t of timers.current) clearTimeout(t);
    };
  }, []);

  function clearTimers(): void {
    for (const t of timers.current) clearTimeout(t);
    timers.current = [];
  }
  function at(ms: number, fn: () => void): void {
    timers.current.push(setTimeout(fn, ms));
  }

  const running =
    stage === "verify" || stage === "paused" || stage === "provision";

  function tryFinish(): void {
    if (!(gate.current.seqDone && gate.current.authOk)) return;
    if (gate.current.finished) return;
    gate.current.finished = true;
    setStage("done");
    at(900, onAuthed);
  }

  function fail(e: unknown): void {
    clearTimers();
    setStage("failed");
    // Never the raw `e.message`: Firebase's is `Firebase: Error (auth/popup-blocked).`, which
    // reads like a crash and says nothing actionable. See ./auth-errors.
    //
    // The App Check hint rides along because Google refuses sign-in BELOW the SDK — the popup
    // gets a 401 and simply never returns a credential, so the code that reaches us describes
    // the symptom (a window that closed) and not the cause we already measured at page load.
    setError(
      withAppCheckHint(authErrorMessage(e), appCheckAttestationFailed()),
    );
  }

  function submit(): void {
    if (running || stage === "done") return;
    setError(null);
    setNotice(null);
    // Secondary path: a pasted `nry_` API token enters directly (no Firebase).
    const token = apiToken.trim();
    if (token) {
      onApiToken(token);
      return;
    }
    if (!configured) {
      setTokenOpen(true);
      setError(
        "Firebase sign-in isn’t configured for this build — paste an API token to continue.",
      );
      return;
    }
    if (!isFormReady({ mode, name: fullName, email, password })) return;
    // Start the staged visual run in sync with the real auth call.
    setProvider(null);
    gate.current = { seqDone: false, authOk: false, finished: false };
    clearTimers();
    setStage("verify");
    at(1000, () => setStage("paused"));
    at(2500, () => setStage("provision"));
    at(3700, () => {
      gate.current.seqDone = true;
      tryFinish();
    });
    const auth =
      mode === "signup"
        ? signupEmail(email.trim(), password, fullName.trim() || undefined)
        : loginEmail(email.trim(), password);
    auth.then(() => {
      gate.current.authOk = true;
      tryFinish();
    }, fail);
  }

  function googleSignIn(): void {
    if (!configured || running || stage === "done") return;
    setError(null);
    setNotice(null);
    // OAuth variant: hold at "waiting for consent" while the popup is open;
    // provision → done only after the real popup promise resolves.
    setProvider("google");
    gate.current = { seqDone: false, authOk: false, finished: false };
    clearTimers();
    setStage("verify");
    at(1000, () => setStage("paused"));
    login().then(() => {
      clearTimers();
      setStage("provision");
      at(700, () => setStage("done"));
      at(1600, onAuthed);
    }, fail);
  }

  // "Forgot?" — real Firebase password-reset email to the typed address.
  async function forgotPassword(): Promise<void> {
    setError(null);
    setNotice(null);
    if (!configured) {
      setError(
        "Password reset needs Firebase sign-in, which isn’t configured here — use your API token instead.",
      );
      return;
    }
    if (!email.trim()) {
      setError("Enter your email above first, then click Forgot.");
      return;
    }
    try {
      await resetPassword(email.trim());
      setNotice(`Password reset email sent to ${email.trim()}.`);
    } catch {
      setError("Couldn’t send a reset email. Check the address and try again.");
    }
  }

  function toggleMode(): void {
    clearTimers();
    gate.current = { seqDone: false, authOk: false, finished: false };
    setStage(null);
    setProvider(null);
    setError(null);
    setNotice(null);
    setMode((m) => (m === "login" ? "signup" : "login"));
  }

  const copy = COPY[mode];
  const signals: SimulationSignals = {
    mode,
    provider,
    stage,
    focus,
    name: fullName,
    email,
    password,
  };
  const ready = isFormReady(signals);
  const canSubmit = Boolean(apiToken.trim()) || (configured && ready);

  // Responsive: side-by-side only on desktop (>1024px, the app-wide single-column
  // threshold); at ≤1024 the canvas stacks under the form (column-reverse) and
  // scales down — the design's scale = min(1,(vw-32)/560). Falling into the narrow
  // branch also drops the fixed 100vh height, so nothing clips on phone/tablet.
  const [vw, vh] = viewport;
  const wide = vw >= 1025;
  // Touch targets ≥44px at ≤1024 (inputs + the Google button); desktop keeps the
  // comp's 42px. Submit is already 44px.
  const controlHeight = wide ? 42 : 44;
  const panelWidth = wide ? Math.max(430, Math.min(760, vw - 470)) : undefined;
  const scale = wide
    ? Math.max(
        0.5,
        Math.min(1, ((panelWidth ?? 560) - 48) / 560, (vh - 230) / 730),
      )
    : Math.min(1, (vw - 32) / 560);

  // Submit button: default → ember gradient CTA; running → spinner; done → ok.
  let submitInner: ReactNode;
  let submitBg = "linear-gradient(180deg,#ff8a4c,#f2622e)";
  let submitDisabled = false;
  if (stage === "done") {
    submitInner = <span>✓ {copy.ctaDone}</span>;
    submitBg = "linear-gradient(180deg,#5fd598,#35c47a)";
    submitDisabled = true;
  } else if (running) {
    submitInner = (
      <>
        <span
          aria-hidden
          style={{
            width: 15,
            height: 15,
            border: "2px solid rgba(255,255,255,.35)",
            borderTopColor: "#fff",
            borderRadius: "50%",
            display: "inline-block",
            animation: "authSpin .7s linear infinite",
          }}
        />
        Running workflow…
      </>
    );
    submitDisabled = true;
  } else {
    submitInner = (
      <>
        {copy.cta}
        <svg width={15} height={15} viewBox="0 0 24 24" fill="none" aria-hidden>
          <path
            d="M5 12h14M13 6l6 6-6 6"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </>
    );
    submitDisabled = !canSubmit;
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: wide ? "row" : "column-reverse",
        minHeight: "100vh",
        height: wide ? "100vh" : undefined,
        background: "#0a0c11",
        color: "#e8ebf1",
        fontFamily: "var(--font-sans)",
        overflow: wide ? "hidden" : undefined,
        WebkitFontSmoothing: "antialiased",
      }}
    >
      {/* LEFT (below the form when narrow): live workflow simulation */}
      <div
        style={{
          width: wide ? panelWidth : "100%",
          flex: "none",
          display: "flex",
        }}
      >
        <WorkflowSimulation signals={signals} wide={wide} scale={scale} />
      </div>

      {/* RIGHT: the real auth form */}
      <div
        style={{
          flex: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: wide ? 40 : "36px 20px",
        }}
      >
        <div style={{ width: 380, maxWidth: "100%" }}>
          {/* brand */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              marginBottom: 26,
            }}
          >
            <Logo size={30} />
            <span style={{ fontSize: 15, fontWeight: 700, color: "#e8ebf1" }}>
              Naary
            </span>
          </div>

          <h1
            style={{
              fontSize: 24,
              fontWeight: 700,
              letterSpacing: "-.01em",
              color: "#e8ebf1",
              margin: 0,
            }}
          >
            {copy.title}
          </h1>
          <p
            style={{
              fontSize: 13,
              color: "#98a2b3",
              marginTop: 5,
              marginBottom: 0,
            }}
          >
            {copy.subtitle}
          </p>

          {/* social — Google only: the app has no GitHub auth path, so the
              design's GitHub button is deliberately omitted. */}
          <div style={{ marginTop: 24 }}>
            <button
              type="button"
              onClick={googleSignIn}
              disabled={!configured || running || stage === "done"}
              style={{
                width: "100%",
                height: controlHeight,
                borderRadius: 9,
                border: `1px solid ${
                  provider === "google" && stage ? "#f2622e" : "#2c3542"
                }`,
                background:
                  provider === "google" && stage ? "#1a1310" : "#12151c",
                color: "#e8ebf1",
                fontSize: 12.5,
                fontWeight: 500,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 8,
                cursor: !configured ? "not-allowed" : "pointer",
                opacity: !configured ? 0.55 : 1,
                transition: "border-color .2s, background .2s",
                fontFamily: "inherit",
              }}
            >
              <GoogleGlyph />
              Continue with Google
            </button>
            {!configured && (
              <div style={{ fontSize: 11.5, color: "#5c6573", marginTop: 8 }}>
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
              margin: "20px 0",
            }}
          >
            <span style={{ flex: 1, height: 1, background: "#222834" }} />
            <span style={{ fontSize: 11, color: "#5c6573" }}>or</span>
            <span style={{ flex: 1, height: 1, background: "#222834" }} />
          </div>

          {/* fields (focus/typing drive the canvas nodes) */}
          {mode === "signup" && (
            <div style={{ marginBottom: 13 }}>
              <div style={labelStyle}>Full name</div>
              <input
                className="authInput"
                type="text"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                onFocus={() => setFocus("name")}
                onBlur={() => setFocus("")}
                placeholder="Maria Alvarez"
                autoComplete="name"
                style={inputStyle(focus === "name", controlHeight)}
              />
            </div>
          )}
          <div style={{ marginBottom: 13 }}>
            <div style={labelStyle}>Work email</div>
            <input
              className="authInput"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onFocus={() => setFocus("email")}
              onBlur={() => setFocus("")}
              placeholder="you@company.io"
              autoComplete="email"
              style={inputStyle(focus === "email", controlHeight)}
            />
          </div>
          <div style={{ marginBottom: 7 }}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                marginBottom: 6,
              }}
            >
              <span style={{ fontSize: 11.5, color: "#98a2b3" }}>Password</span>
              {mode === "login" && (
                <button
                  type="button"
                  onClick={() => void forgotPassword()}
                  style={{ ...linkButtonStyle, fontSize: 11.5 }}
                >
                  Forgot?
                </button>
              )}
            </div>
            <input
              className="authInput"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onFocus={() => setFocus("pw")}
              onBlur={() => setFocus("")}
              placeholder="At least 6 characters"
              autoComplete={
                mode === "login" ? "current-password" : "new-password"
              }
              style={inputStyle(focus === "pw", controlHeight)}
            />
          </div>

          {/* real auth errors / notices render here (honest failure) */}
          {error && (
            <div
              style={{
                marginTop: 14,
                fontSize: 12.5,
                color: "#e07a6a",
                lineHeight: 1.5,
              }}
            >
              {error}
            </div>
          )}
          {notice && (
            <div
              style={{
                marginTop: 14,
                fontSize: 12.5,
                color: "#35c47a",
                lineHeight: 1.5,
              }}
            >
              {notice}
            </div>
          )}

          {/* submit — ember gradient, spinner while the real auth runs */}
          <button
            type="button"
            onClick={submit}
            disabled={submitDisabled}
            style={{
              width: "100%",
              height: 44,
              marginTop: 18,
              borderRadius: 9,
              border: "1px solid rgba(242,98,46,.5)",
              background: submitBg,
              color: "#fff3ec",
              fontSize: 13.5,
              fontWeight: 600,
              cursor: submitDisabled ? "not-allowed" : "pointer",
              opacity: submitDisabled && !running && stage !== "done" ? 0.5 : 1,
              boxShadow: "0 4px 16px -4px rgba(242,98,46,.6)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 8,
              transition: "opacity .2s",
              fontFamily: "inherit",
            }}
          >
            {submitInner}
          </button>

          {/* the `nry_` API-token path, kept reachable */}
          <div style={{ textAlign: "center", marginTop: 12 }}>
            <button
              type="button"
              onClick={() => setTokenOpen((v) => !v)}
              style={{ ...linkButtonStyle, fontSize: 12 }}
            >
              {tokenOpen
                ? "Hide the API token field"
                : "Use an API token instead"}
            </button>
          </div>
          {tokenOpen && (
            <div style={{ marginTop: 10 }}>
              <div style={labelStyle}>API token</div>
              <input
                className="authInput"
                type="text"
                value={apiToken}
                onChange={(e) => setApiToken(e.target.value)}
                onFocus={() => setTokenFocus(true)}
                onBlur={() => setTokenFocus(false)}
                placeholder="nry_…  (paste a minted token)"
                spellCheck={false}
                autoComplete="off"
                style={inputStyle(tokenFocus, controlHeight)}
              />
              <div style={{ fontSize: 11, color: "#5c6573", marginTop: 6 }}>
                Signs you straight in — no Firebase needed. {copy.cta} uses the
                token when present.
              </div>
            </div>
          )}

          {/* switch login/signup */}
          <div
            style={{
              textAlign: "center",
              marginTop: 20,
              fontSize: 12.5,
              color: "#98a2b3",
            }}
          >
            {copy.switchPrompt}{" "}
            <button
              type="button"
              onClick={toggleMode}
              style={{ ...linkButtonStyle, fontSize: 12.5 }}
            >
              {copy.switchAction}
            </button>
          </div>

          {/* terms footer */}
          <div
            style={{
              textAlign: "center",
              marginTop: 24,
              fontSize: 11,
              color: "#5c6573",
              lineHeight: 1.6,
            }}
          >
            By continuing you agree to Naary’s
            <br />
            Terms of Service and Privacy Policy.
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------------- Brand glyph (not part of the line-icon set) ---------------- */
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
