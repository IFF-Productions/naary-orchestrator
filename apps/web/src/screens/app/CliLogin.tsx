/**
 * `/app/cli-login` — the human half of `naary auth` (#1078 §2 shape B, slice 3).
 *
 * A terminal ran `naary auth`, printed a short code and this URL, and is now polling
 * `POST /auth/cli/exchange`. This page is where a signed-in person decides whether that terminal
 * gets a token that acts as them.
 *
 * THREE THINGS THIS SCREEN EXISTS TO DO, none of which are "show a button":
 *
 *  1. **State the object of the consent.** Approving mints an `nry_` access token — a real
 *     workspace credential, in ONE workspace, for a stated lifetime, renewable without asking
 *     again. A screen that asks "Approve?" with no object is how people approve things they would
 *     not have. Every claim on it is checked against the server's constants by
 *     `test/cli-login-copy.drift.spec.ts`.
 *  2. **Make the user code the anti-phishing control it is meant to be.** `POST /auth/cli/start`
 *     returns a verification URI with NO code in it, and there is no lookup endpoint — so the code
 *     is typed here, from the terminal, and echoed back in canonical form for comparison before
 *     the irreversible click. That is deliberate and must stay: if a code could ride in on the URL,
 *     an attacker who started a login could send a victim a link and have them approve the
 *     ATTACKER'S session. No `?code=` prefill. (RFC 8628 calls that `verification_uri_complete`
 *     and warns about exactly this.)
 *  3. **Make refusal a first-class answer.** "This wasn't me" CALLS `deny` — same size, same row,
 *     one click — rather than navigating away. The CLI is polling; it gets a definite answer
 *     instead of a ten-minute silence, and the code is burned so nobody can reuse it.
 *
 * Every refusal is rendered as a distinct, named state (expired / already used / unknown code /
 * wrong role). "Something went wrong" on a security screen tells the user nothing about whether
 * they are now exposed.
 *
 * Routed OUTSIDE AppShell (a sibling of `/app/canvas`, inside RequireAuth) — a focused decision
 * page with no navigation to wander into, and one that a Simple-mode user reaches too, since
 * AppShell's mode gating doesn't apply here.
 */
import { type ReactNode, useState } from "react";
import { Link } from "react-router-dom";
import {
  Button,
  Card,
  Icon,
  type IconName,
  Logo,
  TextInput,
} from "../../components";
import { api, CliLoginError, UnauthorizedError } from "../../lib/api";
import {
  displayUserCode,
  formatUserCodeInput,
  normalizeUserCode,
} from "../../lib/cli-user-code";
import { PHONE_QUERY, useMediaQuery } from "../../lib/useMediaQuery";
import { useWorkspace } from "../../workspace/WorkspaceProvider";
import { workspaceLabel } from "../../workspace/WorkspaceSwitcher";
import {
  CLI_ACCESS_TOKEN_TTL_HOURS,
  CLI_CODE_WINDOW_MINUTES,
  CLI_REFRESH_ABSOLUTE_DAYS,
  CLI_REFRESH_IDLE_DAYS,
  failureCopy,
  forbiddenGuidance,
} from "./cli-login.copy";

type Outcome =
  { kind: "approved"; label: string } | { kind: "denied"; label: string };

/**
 * The half-typed code, carried across the remount a workspace switch causes.
 *
 * WorkspaceProvider keys its subtree by the active workspace, so choosing a different one below
 * UNMOUNTS this component — and a user who types the code, notices the wrong workspace and fixes
 * it would watch the page silently eat their input. In memory only, one tab, cleared on every
 * decision: a device code has no business in storage that outlives the tab.
 */
let carriedCode = "";

export function CliLogin() {
  const { workspaces, activeId, setActive } = useWorkspace();
  const phone = useMediaQuery(PHONE_QUERY);
  const [raw, setRawState] = useState(carriedCode);
  const setRaw = (v: string) => {
    carriedCode = v;
    setRawState(v);
  };
  const [busy, setBusy] = useState<"approve" | "deny" | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  // The attempted decision travels WITH the failure: a role refusal must be explained in terms of
  // the button that was pressed (see `forbiddenGuidance`), and `busy` is cleared by then.
  const [failure, setFailure] = useState<{
    error: CliLoginError;
    attempted: "approve" | "deny";
  } | null>(null);

  const code = normalizeUserCode(raw);
  const active = workspaces.find((w) => w.tenantId === activeId);
  const wsName = active ? workspaceLabel(active.tenantId, active.name) : "—";
  // ADVISORY ONLY. The server decides (AuthGuard backfills owner on legacy claim-tenant users, so
  // the role listed here and `principal.role` need not agree) — so this warns, and never disables
  // the button. The real answer is the 403 branch below.
  const roleLikelyBlocked =
    !!active && active.role !== "owner" && active.role !== "admin";

  async function decide(decision: "approve" | "deny"): Promise<void> {
    if (!code || busy) return;
    setBusy(decision);
    setFailure(null);
    try {
      const res = await api.decideCliLogin(code, decision);
      // Decided — the code is spent either way, so don't carry it into the next mount.
      carriedCode = "";
      setOutcome({
        kind: res.status === "approved" ? "approved" : "denied",
        label: res.label,
      });
    } catch (e) {
      // The session died between load and click. Not a role problem and not a code problem —
      // saying either would send the user hunting for the wrong thing.
      const error =
        e instanceof UnauthorizedError
          ? new CliLoginError("session_expired", "")
          : e instanceof CliLoginError
            ? e
            : new CliLoginError(
                "unavailable",
                e instanceof Error ? e.message : "The request was refused.",
              );
      setFailure({ error, attempted: decision });
    } finally {
      setBusy(null);
    }
  }

  function reset(): void {
    setRaw("");
    setFailure(null);
    setOutcome(null);
  }

  return (
    <Frame>
      {/* `margin: auto`, NOT the frame's `align-items: center`. On a phone the consent card is
          taller than the viewport, and a centered flex item that overflows its container is
          clipped at BOTH ends with no way to scroll to them — the grants list and both buttons
          were unreachable at 390×844. Auto margins centre when there is room and collapse when
          there isn't. */}
      <Card
        style={{ width: "100%", maxWidth: 520, margin: "auto" }}
        pad={false}
      >
        <div style={{ padding: phone ? "24px 18px" : "30px 30px 26px" }}>
          {outcome ? (
            <Decided outcome={outcome} workspace={wsName} onAgain={reset} />
          ) : failure ? (
            <Refused
              failure={failure.error}
              attempted={failure.attempted}
              workspace={wsName}
              role={active?.role}
              onAgain={reset}
            />
          ) : (
            <Consent
              raw={raw}
              code={code}
              busy={busy}
              phone={phone}
              workspaces={workspaces}
              activeId={activeId}
              workspaceName={wsName}
              roleLikelyBlocked={roleLikelyBlocked}
              role={active?.role ?? "member"}
              onWorkspace={setActive}
              onRaw={setRaw}
              onDecide={decide}
            />
          )}
        </div>
      </Card>
    </Frame>
  );
}

/* ------------------------------------------------------------------ layout */

function Frame({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        background: "var(--bg)",
        padding: 20,
        fontFamily: "var(--font-sans)",
        color: "var(--ink)",
      }}
    >
      {children}
    </div>
  );
}

function Header({
  title,
  body,
  logo = true,
}: {
  title: string;
  body: ReactNode;
  /** End states lead with their own result tile — two stacked tiles read as a rendering bug. */
  logo?: boolean;
}) {
  return (
    <div style={{ marginBottom: 20 }}>
      {logo && (
        <div style={{ display: "inline-flex", marginBottom: 14 }}>
          <Logo size={34} />
        </div>
      )}
      <h1
        style={{
          fontSize: 20,
          fontWeight: 700,
          letterSpacing: "-.01em",
          margin: 0,
        }}
      >
        {title}
      </h1>
      <div
        style={{
          fontSize: 13,
          color: "var(--ink-2)",
          marginTop: 8,
          lineHeight: "var(--leading-body)",
        }}
      >
        {body}
      </div>
    </div>
  );
}

/** One line of "what approving grants" — icon, then the claim in plain language. */
function Grant({ icon, children }: { icon: IconName; children: ReactNode }) {
  return (
    <li
      style={{
        display: "flex",
        gap: 10,
        alignItems: "flex-start",
        fontSize: 12.5,
        color: "var(--ink-soft)",
        lineHeight: "var(--leading-body)",
      }}
    >
      <span style={{ color: "var(--ink-faint)", marginTop: 1, flex: "none" }}>
        <Icon name={icon} size={15} />
      </span>
      <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>{children}</span>
    </li>
  );
}

/** A tinted callout (the code-match warning, the role advisory). */
function Callout({
  tone,
  children,
}: {
  tone: "warn" | "info";
  children: ReactNode;
}) {
  const fg = tone === "warn" ? "var(--state-paused)" : "var(--state-info)";
  const bg = tone === "warn" ? "var(--paused-soft)" : "var(--info-soft)";
  return (
    <div
      style={{
        display: "flex",
        gap: 10,
        alignItems: "flex-start",
        background: bg,
        border: `1px solid color-mix(in srgb, ${fg} 40%, transparent)`,
        borderRadius: 10,
        padding: "11px 13px",
        fontSize: 12.5,
        color: "var(--ink-soft)",
        lineHeight: "var(--leading-body)",
      }}
    >
      <span style={{ color: fg, marginTop: 1, flex: "none" }}>
        <Icon name={tone === "warn" ? "alert" : "info"} size={15} />
      </span>
      <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>{children}</span>
    </div>
  );
}

/* ----------------------------------------------------------------- consent */

function Consent({
  raw,
  code,
  busy,
  phone,
  workspaces,
  activeId,
  workspaceName,
  roleLikelyBlocked,
  role,
  onWorkspace,
  onRaw,
  onDecide,
}: {
  raw: string;
  code: string;
  busy: "approve" | "deny" | null;
  phone: boolean;
  workspaces: { tenantId: string; name?: string; role: string }[];
  activeId: string | null;
  workspaceName: string;
  roleLikelyBlocked: boolean;
  /** The caller's role in the active workspace, shown verbatim in the advisory. */
  role: string;
  onWorkspace: (id: string) => void;
  onRaw: (v: string) => void;
  onDecide: (d: "approve" | "deny") => void;
}) {
  return (
    <>
      <Header
        title="Authorize a command-line sign-in"
        body={
          <>
            A terminal running <Code>naary auth</Code> is waiting for an answer.
            Approving gives that terminal an access token that acts as you.
          </>
        }
      />

      {/* WHICH WORKSPACE. The token is minted in the ACTIVE workspace, so on a multi-workspace
          account this select is part of the consent, not chrome — it decides what the CLI can
          reach. Switching here persists (it is the same active-workspace state the shell's
          switcher writes), which is why the label says so plainly. */}
      <label
        style={{
          display: "block",
          fontSize: 11,
          textTransform: "uppercase",
          letterSpacing: ".06em",
          color: "var(--ink-faint)",
          marginBottom: 7,
        }}
        htmlFor="cli-login-workspace"
      >
        Workspace
      </label>
      {workspaces.length > 1 ? (
        <select
          id="cli-login-workspace"
          value={activeId ?? ""}
          onChange={(e) => onWorkspace(e.target.value)}
          style={{
            width: "100%",
            height: 44,
            borderRadius: 10,
            border: "1px solid var(--line-2)",
            background: "var(--card)",
            color: "var(--ink)",
            fontSize: 13,
            fontFamily: "var(--font-sans)",
            padding: "0 11px",
            marginBottom: 18,
          }}
        >
          {workspaces.map((w) => (
            <option key={w.tenantId} value={w.tenantId}>
              {workspaceLabel(w.tenantId, w.name)} · {w.role}
            </option>
          ))}
        </select>
      ) : (
        <div
          id="cli-login-workspace"
          style={{
            height: 44,
            display: "flex",
            alignItems: "center",
            borderRadius: 10,
            border: "1px solid var(--line)",
            background: "var(--card)",
            padding: "0 11px",
            fontSize: 13,
            marginBottom: 18,
          }}
        >
          {workspaceName}
        </div>
      )}

      {/* Neutral between the two buttons ON PURPOSE. The server gates `deny` with the same
          owner/admin check as `approve`, so this warning applies to refusing as well — and telling
          someone looking at a code they didn't generate to "ask an owner to approve it" would be
          exactly the wrong instruction. The role is interpolated, not hardcoded to "member": the
          gate is "not owner and not admin", and RBAC groups can put other names in there. */}
      {roleLikelyBlocked && (
        <div style={{ marginBottom: 18 }}>
          <Callout tone="info">
            Your role in {workspaceName} is <strong>{role}</strong>. Deciding a
            CLI login — approving <em>or</em> refusing one — is limited to
            owners and admins, so this will most likely be refused. Ask an owner
            or admin to handle it, or switch to a workspace you own.
          </Callout>
        </div>
      )}

      {/* THE CODE. Typed, never pre-filled from the URL — see the file header. */}
      <label
        style={{
          display: "block",
          fontSize: 11,
          textTransform: "uppercase",
          letterSpacing: ".06em",
          color: "var(--ink-faint)",
          marginBottom: 7,
        }}
        htmlFor="cli-login-code"
      >
        Code from your terminal
      </label>
      <TextInput
        id="cli-login-code"
        value={raw}
        onChange={(e) => onRaw(formatUserCodeInput(e.target.value))}
        placeholder="PQ4M-TWZ9"
        autoFocus
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        aria-describedby="cli-login-code-help"
        // Deliberately NOT inside a <form>: Enter must not submit. Approving is irreversible and
        // grants a real credential — it takes a considered click, not a reflex keystroke at the
        // end of typing a code.
        style={{
          width: "100%",
          height: 54,
          fontFamily: "var(--font-mono)",
          fontSize: 22,
          fontWeight: 600,
          letterSpacing: ".16em",
          textAlign: "center",
          textTransform: "uppercase",
        }}
      />
      <div
        id="cli-login-code-help"
        style={{
          fontSize: 11.5,
          color: "var(--ink-3)",
          marginTop: 7,
          lineHeight: "var(--leading-body)",
        }}
      >
        8 characters, e.g. PQ4M-TWZ9. Codes expire {CLI_CODE_WINDOW_MINUTES}{" "}
        minutes after your terminal prints them.
      </div>

      {/* The match check — the entire anti-phishing property of the flow, stated as such. */}
      {code && (
        <div style={{ marginTop: 16 }}>
          <Callout tone="warn">
            You're about to authorize{" "}
            <strong
              style={{
                fontFamily: "var(--font-mono)",
                color: "var(--ink)",
                letterSpacing: ".06em",
              }}
            >
              {displayUserCode(code)}
            </strong>
            . Check it matches the code in your terminal, character for
            character. If it doesn't — or you didn't start this — approving
            would sign <em>someone else's</em> terminal in as you.
          </Callout>
        </div>
      )}

      <div
        style={{
          marginTop: 20,
          paddingTop: 18,
          borderTop: "1px solid var(--line)",
        }}
      >
        <div
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: "var(--ink-2)",
            marginBottom: 11,
          }}
        >
          What approving gives that terminal
        </div>
        <ul
          style={{
            listStyle: "none",
            margin: 0,
            padding: 0,
            display: "flex",
            flexDirection: "column",
            gap: 9,
          }}
        >
          <Grant icon="key">
            An API token that <strong>acts as you</strong> — full access to this
            workspace, not a reduced subset of it.
          </Grant>
          <Grant icon="workflow">
            <strong>{workspaceName}</strong> only. Your other workspaces are
            untouched.
          </Grant>
          <Grant icon="clock">
            The token expires in{" "}
            <strong>{CLI_ACCESS_TOKEN_TTL_HOURS} hours</strong>.
          </Grant>
          <Grant icon="refresh">
            The CLI can renew it <strong>without asking you again</strong> — for
            up to {CLI_REFRESH_IDLE_DAYS} days of continued use, and never
            beyond {CLI_REFRESH_ABSOLUTE_DAYS} days.
          </Grant>
          <Grant icon="trash">
            Revoke it any time in <SettingsLink />; it's listed as{" "}
            <Code>naary CLI — &lt;device&gt;</Code>
            {"."}
          </Grant>
        </ul>
      </div>

      <div
        style={{
          display: "flex",
          flexDirection: phone ? "column" : "row",
          gap: 10,
          marginTop: 22,
        }}
      >
        {/* Same size, same row, both one click — refusing must cost no more than agreeing. */}
        <Button
          variant="primary"
          size="lg"
          block
          icon="check"
          style={{ flex: 1 }}
          disabled={!code || busy !== null}
          loading={busy === "approve"}
          onClick={() => onDecide("approve")}
        >
          Approve sign-in
        </Button>
        <Button
          variant="secondary"
          size="lg"
          block
          icon="x"
          style={{ flex: 1 }}
          disabled={!code || busy !== null}
          loading={busy === "deny"}
          onClick={() => onDecide("deny")}
        >
          No — I didn't start this
        </Button>
      </div>
      <div
        style={{
          fontSize: 12,
          color: "var(--ink-2)",
          marginTop: 12,
          lineHeight: "var(--leading-body)",
        }}
      >
        Refusing cancels the code immediately and tells the waiting terminal it
        was denied. If you aren't sure, refuse — a genuine sign-in is one{" "}
        <Code>naary auth</Code> away.
      </div>
    </>
  );
}

/* ------------------------------------------------------------- end states */

function Decided({
  outcome,
  workspace,
  onAgain,
}: {
  outcome: Outcome;
  workspace: string;
  onAgain: () => void;
}) {
  const ok = outcome.kind === "approved";
  return (
    <>
      <ResultIcon tone={ok ? "ok" : "idle"} icon={ok ? "check" : "x"} />
      <Header
        logo={false}
        title={ok ? "Terminal authorized" : "Sign-in refused"}
        body={
          ok ? (
            <>
              <strong style={{ color: "var(--ink)" }}>{outcome.label}</strong>{" "}
              can now act as you in{" "}
              <strong style={{ color: "var(--ink)" }}>{workspace}</strong>. Go
              back to your terminal — it should already be signed in. The token
              expires in {CLI_ACCESS_TOKEN_TTL_HOURS} hours and you can revoke
              it any time in <SettingsLink />
              {"."}
            </>
          ) : (
            <>
              That code is now dead — no token was issued, and nobody can use
              it. The terminal waiting on it has been told it was refused. If it
              was your own sign-in after all, run <Code>naary auth</Code> again
              for a new code.
            </>
          )
        }
      />
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <Link to="/app" style={{ textDecoration: "none" }}>
          <Button variant="secondary" icon="arrow-right">
            Back to Naary
          </Button>
        </Link>
        <Button variant="ghost" onClick={onAgain}>
          Authorize another code
        </Button>
      </div>
    </>
  );
}

function Refused({
  failure,
  attempted,
  workspace,
  role,
  onAgain,
}: {
  failure: CliLoginError;
  /** Which button produced this refusal. Load-bearing for the 403 — `deny` is gated by the same
   *  owner/admin check as `approve`, so a member who tried to REFUSE a code lands here too. */
  attempted: "approve" | "deny";
  workspace: string;
  role?: string;
  onAgain: () => void;
}) {
  const copy = failureCopy(failure.reason, failure.serverMessage);
  const soft = failure.reason === "forbidden" || copy.signIn;
  return (
    <>
      <ResultIcon tone={soft ? "idle" : "warn"} icon={soft ? "key" : "alert"} />
      <Header
        logo={false}
        title={copy.title}
        body={
          <>
            {withCode(copy.body)}
            {failure.reason === "forbidden" && (
              <div style={{ marginTop: 8 }}>
                {role ? (
                  <>
                    Your role in {workspace} is <strong>{role}</strong>.{" "}
                  </>
                ) : null}
                {forbiddenGuidance(attempted, workspace)}
              </div>
            )}
          </>
        }
      />
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        {copy.retry && (
          <Button variant="primary" icon="refresh" onClick={onAgain}>
            Enter another code
          </Button>
        )}
        {copy.signIn && (
          <Link to="/auth" style={{ textDecoration: "none" }}>
            <Button variant="primary" icon="key">
              Sign in again
            </Button>
          </Link>
        )}
        <Link to="/app" style={{ textDecoration: "none" }}>
          <Button variant="secondary">Back to Naary</Button>
        </Link>
      </div>
    </>
  );
}

function ResultIcon({
  tone,
  icon,
}: {
  tone: "ok" | "warn" | "idle";
  icon: IconName;
}) {
  const fg =
    tone === "ok"
      ? "var(--state-done)"
      : tone === "warn"
        ? "var(--state-paused)"
        : "var(--ink-2)";
  const bg =
    tone === "ok"
      ? "var(--done-soft)"
      : tone === "warn"
        ? "var(--paused-soft)"
        : "var(--idle-soft)";
  return (
    <div
      style={{
        width: 48,
        height: 48,
        borderRadius: 14,
        background: bg,
        border: `1px solid color-mix(in srgb, ${fg} 45%, transparent)`,
        color: fg,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        marginBottom: 16,
      }}
    >
      <Icon name={icon} size={22} strokeWidth={2.2} />
    </div>
  );
}

/** Render a copy string's `backticked` spans as inline code. The failure copy lives in a plain
 *  `.ts` module (so it can be unit-tested without rendering), and `naary auth` in it is an
 *  instruction to TYPE something — it has to look like one rather than arriving as stray
 *  punctuation. */
function withCode(text: string): ReactNode {
  return text
    .split(/`([^`]+)`/)
    .map((part, i) =>
      i % 2 === 1 ? <Code key={i}>{part}</Code> : <span key={i}>{part}</span>,
    );
}

/** Where a CLI token is listed and revoked. Named as a link, and looking like one — a revocation
 *  route the user can't SEE is the same as not offering it. */
function SettingsLink() {
  return (
    <Link
      to="/app/settings"
      style={{ color: "var(--brand)", textDecoration: "underline" }}
    >
      Settings → API tokens
    </Link>
  );
}

/** Inline command/label in mono — `naary auth`, the token label. */
function Code({ children }: { children: ReactNode }) {
  return (
    <span
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: "0.92em",
        color: "var(--ink)",
        background: "var(--card-2)",
        border: "1px solid var(--line)",
        borderRadius: 5,
        padding: "1px 5px",
        overflowWrap: "anywhere",
      }}
    >
      {children}
    </span>
  );
}
