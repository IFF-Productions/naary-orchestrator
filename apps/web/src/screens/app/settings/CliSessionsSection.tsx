// CLI sessions section (#1078 §5) — "which machines am I signed in on, and sign this one out".
//
// A sibling of the API-tokens card in Integrations → MCP & API, deliberately NOT the same list:
// an API token is a workspace credential someone minted on purpose, a CLI session is a DEVICE a
// human logged in from. §5 asks for them kept apart, and they answer different questions.
//
// One row per SESSION, not per token. `naary auth` rotates its refresh token on every use, so a
// laptop signed in for a fortnight is ~30 rows in the database and exactly one row here — the
// server groups by rotation family before it answers.
//
// OWN SESSIONS ONLY. `GET /cli-sessions` is scoped to the authenticated user, and there is no
// admin view of a colleague's devices: offboarding already revokes a departing member's sessions
// automatically (#1117), so an admin loses no capability and nobody gains a surveillance surface.
import { useCallback, useEffect, useState } from "react";
import { Button, useConfirm } from "../../../components";
import {
  api,
  type CliSession,
  HttpError,
  UnauthorizedError,
} from "../../../lib/api";
import { ago, deviceName, exact } from "./cli-sessions.model";
import { ErrorLine, panelStyle, SectionHeader, SectionIntro } from "./shared";

function friendlyError(e: unknown, fallback: string): string {
  if (e instanceof UnauthorizedError) return "Sign in to manage CLI sessions.";
  if (e instanceof HttpError && e.serverMessage) return e.serverMessage;
  return fallback;
}

/** Laptop glyph — a session is a MACHINE, and the icon is the fastest way to say so. */
function DeviceGlyph() {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill="none"
      style={{ flex: "none", color: "var(--ink-faint)" }}
      aria-hidden
    >
      <rect
        x="4"
        y="5"
        width="16"
        height="11"
        rx="2"
        stroke="currentColor"
        strokeWidth="1.7"
      />
      <path
        d="M2.5 19h19"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function CliSessionsSection() {
  const confirm = useConfirm();
  const [sessions, setSessions] = useState<CliSession[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Whether the LAST read failed — distinct from `error`, which a failed REVOKE also sets. Only a
  // failed read may suppress the empty state; a failed revoke leaves a list we genuinely fetched.
  const [readFailed, setReadFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      setSessions(await api.listCliSessions());
      setReadFailed(false);
      setError(null);
    } catch (e) {
      setError(friendlyError(e, "Could not load your CLI sessions."));
      // A failed read must not leave the skeleton up forever pretending to be busy — and it must
      // NOT fall through to the empty state, which the previous version did: setting `[]` here
      // rendered "No CLI sessions" on a screen someone opens BECAUSE they suspect a session they
      // did not start. That is the page asserting the exact reassurance it has no evidence for.
      // `readFailed` keeps the two apart: we asked and there are none, versus we could not ask.
      setReadFailed(true);
      setSessions((prev) => prev ?? []);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function revoke(session: CliSession) {
    const ok = await confirm({
      title: `Sign out ${deviceName(session)}?`,
      // Precise about WHEN, because it isn't instant and a security screen that overstates is
      // worse than one that explains: revoking kills the refresh family immediately, but the
      // 12-hour access token that device already holds isn't recalled — it expires.
      body: (
        <>
          That device will have to run{" "}
          <code className="mono" style={{ color: "var(--ink-soft)" }}>
            naary auth
          </code>{" "}
          again. Its current access token keeps working until it expires, within
          12 hours.
        </>
      ),
      confirmLabel: "Sign out device",
      danger: true,
    });
    if (!ok) return;
    setBusy(session.familyId);
    setError(null);
    try {
      await api.revokeCliSession(session.familyId);
      // Drop it locally rather than waiting on a refetch, so the row goes the instant it is gone.
      setSessions((prev) =>
        (prev ?? []).filter((s) => s.familyId !== session.familyId),
      );
    } catch (e) {
      setError(friendlyError(e, "Could not sign that device out."));
      // The list is now suspect (it may have been revoked by another tab, or not at all) — re-read
      // rather than leaving a row whose state we are guessing at.
      await load();
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <SectionHeader title="CLI sessions" />
      <SectionIntro>
        Machines signed in to this workspace through{" "}
        <code className="mono" style={{ color: "var(--ink-soft)" }}>
          naary auth
        </code>
        . One row per device, however often it has refreshed. “Last used” is the
        session’s most recent token refresh, so it moves roughly twice a day
        while a machine is in use. These are <strong>your</strong> sessions —
        other members’ devices are not listed here, and a member removed from
        the workspace is signed out automatically.
      </SectionIntro>

      {error && <ErrorLine>{error}</ErrorLine>}

      <div style={panelStyle}>
        {sessions === null && (
          <div
            style={{
              padding: "16px 18px",
              fontSize: "var(--text-sm)",
              color: "var(--ink-3)",
            }}
          >
            Loading sessions…
          </div>
        )}
        {readFailed && sessions?.length === 0 && (
          <div
            style={{
              padding: "16px 18px",
              fontSize: "var(--text-sm)",
              color: "var(--ink-3)",
            }}
          >
            Your sessions could not be loaded, so this list is not showing them
            — it does not mean you have none.{" "}
            <button
              type="button"
              onClick={() => void load()}
              style={{
                background: "none",
                border: "none",
                padding: 0,
                font: "inherit",
                color: "var(--brand)",
                cursor: "pointer",
                textDecoration: "underline",
              }}
            >
              Try again
            </button>
            .
          </div>
        )}
        {!readFailed && sessions?.length === 0 && (
          <div
            style={{
              padding: "16px 18px",
              fontSize: "var(--text-sm)",
              color: "var(--ink-3)",
            }}
          >
            No CLI sessions. Run{" "}
            <code className="mono" style={{ color: "var(--ink-soft)" }}>
              naary auth
            </code>{" "}
            on a machine to sign it in — it opens this app in your browser to
            confirm.
          </div>
        )}
        {(sessions ?? []).map((session, i) => (
          <div
            key={session.familyId}
            className="naary-set-row"
            style={{
              display: "flex",
              alignItems: "center",
              flexWrap: "wrap",
              gap: 14,
              padding: "13px 18px",
              borderTop: i === 0 ? undefined : "1px solid var(--line)",
            }}
          >
            <DeviceGlyph />
            <div style={{ flex: 1, minWidth: 160 }}>
              <div
                style={{
                  fontSize: 13,
                  fontWeight: "var(--weight-semibold)",
                  color: "var(--ink)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
                title={deviceName(session)}
              >
                {deviceName(session)}
              </div>
              <div
                className="mono"
                style={{
                  fontSize: "var(--text-2xs)",
                  color: "var(--ink-3)",
                  marginTop: 3,
                }}
              >
                <span title={exact(session.lastUsedAt)}>
                  last used {ago(session.lastUsedAt)}
                </span>
                {" · "}
                <span title={exact(session.createdAt)}>
                  signed in {ago(session.createdAt)}
                </span>
                {" · "}
                <span title={exact(session.expiresAt)}>
                  expires {new Date(session.expiresAt).toLocaleDateString()}
                </span>
              </div>
            </div>
            <Button
              variant="secondary"
              size="sm"
              loading={busy === session.familyId}
              disabled={busy !== null}
              onClick={() => void revoke(session)}
            >
              Sign out
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}
