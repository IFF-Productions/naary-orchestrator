import { useCallback, useEffect, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { Icon, Logo } from "../components";
import { api } from "../lib/api";
import {
  ButtonSpinner,
  PUBLIC_CARD,
  PUBLIC_INPUT,
  PublicFrame,
  PublicNotice,
  ResultBadge,
  SecureFooter,
} from "./public/PublicShell";

/**
 * PUBLIC approve/reject page (the notification-links gap). Reached at `/approve/:workflowId?token=…`,
 * OUTSIDE RequireAuth — a recipient of the pause notification decides WITHOUT opening the app. The
 * token in the URL is the credential (HMAC over the workflowId). A GET fetch is safe (idempotent);
 * the actual decision is a POST behind an explicit button click, so an email prefetch can't approve.
 *
 * Redesign: the Approvals design's public view — centered card with brand tile, review copy,
 * the gate's instructions, optional comment, green-gradient Approve / Reject, secure-link footer,
 * and pop-in Approved/Rejected decided states (from the server's recorded outcome). Slice 1: the
 * prompt now carries the workspace display name (trust line), the gate's pause-time context
 * fields (key/value card), and the link's expiry — each rendered only when the API provides it.
 * Links minted from Slice 1 on also carry an `exp` claim signed into the token; it's passed back
 * on both the fetch and the decision (legacy links have none and keep working).
 */
/** "expires in 6d 23h" while in the future, else an absolute date (already-expired links 401). */
function formatExpiry(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (Number.isNaN(ms)) return "soon";
  if (ms <= 0) return "now";
  const h = Math.floor(ms / 3_600_000);
  if (h < 1) return `in ${Math.max(1, Math.floor(ms / 60_000))}m`;
  if (h < 48) return `in ${h}h`;
  const d = Math.floor(h / 24);
  const rem = h % 24;
  return `in ${d}d${rem > 0 ? ` ${rem}h` : ""}`;
}

export function ApprovePage() {
  const { workflowId } = useParams<{ workflowId: string }>();
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const exp = params.get("exp") ?? undefined;
  // A Slack/Teams Approve or Reject button deep-links here with the choice pre-selected.
  // We DON'T auto-submit (a link-prefetch must not be able to decide) — instead we
  // emphasize + focus that action so the recipient confirms in one click.
  const decisionParam = params.get("decision");
  const intended: "approve" | "reject" | null =
    decisionParam === "approve" || decisionParam === "reject"
      ? decisionParam
      : null;
  const [state, setState] = useState<
    "loading" | "ready" | "closed" | "invalid"
  >("loading");
  const [prompt, setPrompt] = useState<{
    title?: string;
    instructions?: string | null;
    workspaceName?: string | null;
    contextFields?: Record<string, string> | null;
    expiresAt?: string | null;
  }>({});
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [done, setDone] = useState<"approved" | "rejected" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!workflowId || !token) {
      setState("invalid");
      return;
    }
    try {
      const p = await api.getApprovalPrompt(workflowId, token, exp);
      if (!p.awaiting) {
        setState("closed");
        return;
      }
      setPrompt({
        title: p.title,
        instructions: p.instructions,
        workspaceName: p.workspaceName,
        contextFields: p.contextFields,
        expiresAt: p.expiresAt,
      });
      setState("ready");
    } catch {
      setState("invalid");
    }
  }, [workflowId, token, exp]);

  useEffect(() => {
    void load();
  }, [load]);

  async function decide(decision: "approve" | "reject") {
    if (!workflowId || busy) return;
    setBusy(decision);
    setError(null);
    try {
      const res = await api.decideApproval(
        workflowId,
        token,
        decision,
        comment.trim(),
        exp,
      );
      // Show the server's RECORDED outcome, not just the button we clicked.
      setDone(res.status);
    } catch (e) {
      // A 409 = the run was already decided/closed between load and click.
      setError(
        e instanceof Error && /409/.test(e.message)
          ? "This run is no longer awaiting approval."
          : "Could not record your decision. Try again.",
      );
    } finally {
      setBusy(null);
    }
  }

  const card = (children: React.ReactNode, style?: React.CSSProperties) => (
    <PublicFrame>
      <div style={{ width: "100%", maxWidth: 480 }}>
        <div style={{ ...PUBLIC_CARD, ...style }}>{children}</div>
      </div>
    </PublicFrame>
  );

  if (state === "loading")
    return card(
      <div
        style={{ padding: "36px 28px", fontSize: 13, color: "var(--ink-3)" }}
      >
        Loading…
      </div>,
    );

  if (state === "invalid")
    return card(
      <div style={{ padding: "36px 28px" }}>
        <PublicNotice
          icon="alert"
          title="Invalid or expired link"
          body="This approval link is missing or no longer valid."
        />
      </div>,
    );

  if (state === "closed")
    return card(
      <div style={{ padding: "36px 28px" }}>
        <PublicNotice
          icon="check-circle"
          tone="ok"
          title="Already decided"
          body="This run is no longer awaiting approval."
        />
      </div>,
    );

  if (done)
    return card(
      <div style={{ padding: "44px 32px", textAlign: "center" }}>
        <ResultBadge
          tone={done === "approved" ? "ok" : "bad"}
          icon={done === "approved" ? "check" : "x"}
          size={60}
        />
        <div style={{ fontSize: 20, fontWeight: 700, marginTop: 18 }}>
          {done === "approved" ? "Approved — thank you" : "Rejected"}
        </div>
        <div
          style={{
            fontSize: 13,
            color: "var(--ink-2)",
            marginTop: 8,
            lineHeight: 1.6,
            maxWidth: 340,
            marginLeft: "auto",
            marginRight: "auto",
          }}
        >
          {done === "approved"
            ? "Your decision was recorded and the workflow has resumed. You can close this page."
            : "Your decision was recorded and sent to the workflow. You can close this page."}
        </div>
      </div>,
    );

  return card(
    <div style={{ overflow: "hidden" }}>
      {/* header */}
      <div
        style={{
          padding: "26px 28px 22px",
          borderBottom: "1px solid var(--line)",
          textAlign: "center",
        }}
      >
        <div style={{ display: "inline-flex", marginBottom: 14 }}>
          <Logo size={38} />
        </div>
        <div style={{ fontSize: 19, fontWeight: 700, letterSpacing: "-.01em" }}>
          {prompt.title ?? "Approval required"}
        </div>
        <div
          style={{
            fontSize: 13,
            color: "var(--ink-2)",
            marginTop: 6,
            lineHeight: 1.55,
          }}
        >
          You've been asked to review this request
          {prompt.workspaceName ? (
            <>
              {" "}
              on behalf of{" "}
              <strong style={{ color: "var(--ink)" }}>
                {prompt.workspaceName}
              </strong>
            </>
          ) : null}
          . Your decision resumes the workflow immediately.
        </div>
      </div>

      {/* context + decision */}
      <div style={{ padding: "22px 28px" }}>
        {prompt.contextFields &&
          Object.keys(prompt.contextFields).length > 0 && (
            <div
              style={{
                border: "1px solid var(--line-mid)",
                background: "var(--card)",
                borderRadius: 12,
                overflow: "hidden",
                marginBottom: 16,
              }}
            >
              {Object.entries(prompt.contextFields).map(([k, v], i, arr) => (
                <div
                  key={k}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    padding: "9px 14px",
                    borderBottom:
                      i < arr.length - 1 ? "1px solid var(--line)" : "none",
                  }}
                >
                  <span
                    style={{
                      fontSize: 11.5,
                      color: "var(--ink-faint)",
                      width: 110,
                      flex: "none",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {k}
                  </span>
                  <span
                    style={{
                      fontSize: 12.5,
                      color: "var(--ink)",
                      fontWeight: 600,
                      fontFamily: "var(--font-mono)",
                      overflowWrap: "anywhere",
                    }}
                  >
                    {v}
                  </span>
                </div>
              ))}
            </div>
          )}
        {prompt.instructions && (
          <div
            style={{
              border: "1px solid var(--line-mid)",
              background: "var(--card)",
              borderRadius: 12,
              padding: "13px 15px",
              fontSize: 12.5,
              color: "var(--ink-soft)",
              lineHeight: 1.6,
              marginBottom: 16,
              whiteSpace: "pre-wrap",
            }}
          >
            {prompt.instructions}
          </div>
        )}

        {intended && (
          <div
            style={{
              fontSize: 12,
              color: "var(--ink-soft)",
              marginBottom: 12,
              lineHeight: 1.5,
            }}
          >
            You chose to{" "}
            <strong style={{ color: "var(--ink)" }}>
              {intended === "approve" ? "approve" : "reject"}
            </strong>{" "}
            this run — add an optional comment and confirm below.
          </div>
        )}

        <textarea
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder="Add a comment (optional)…"
          aria-label="Reason"
          style={{
            ...PUBLIC_INPUT,
            height: 60,
            padding: "10px 12px",
            fontSize: 12.5,
            resize: "none",
            marginBottom: 12,
          }}
        />

        {error && (
          <div
            style={{
              fontSize: 12,
              color: "var(--state-error)",
              marginBottom: 12,
            }}
          >
            {error}
          </div>
        )}

        <div style={{ display: "flex", gap: 11 }}>
          <button
            disabled={!!busy}
            autoFocus={intended === "approve"}
            onClick={() => void decide("approve")}
            style={{
              flex: 1,
              height: 46,
              borderRadius: 11,
              border:
                "1px solid color-mix(in srgb, var(--state-done) 45%, transparent)",
              background: "linear-gradient(180deg, #3fce86, #1f9a5c)",
              color: "#04120b",
              fontSize: 14,
              fontWeight: 700,
              fontFamily: "var(--font-sans)",
              cursor: busy ? "default" : "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 8,
              boxShadow: "0 4px 14px -5px rgba(53, 196, 122, .5)",
              opacity: intended === "reject" ? 0.6 : 1,
            }}
          >
            {busy === "approve" ? (
              <ButtonSpinner color="#04120b" />
            ) : (
              <Icon name="check" size={16} strokeWidth={2.4} />
            )}
            Approve
          </button>
          <button
            disabled={!!busy}
            autoFocus={intended === "reject"}
            onClick={() => void decide("reject")}
            style={{
              flex: 1,
              height: 46,
              borderRadius: 11,
              border:
                "1px solid color-mix(in srgb, var(--state-error) 45%, transparent)",
              background: "var(--error-soft)",
              color: "var(--state-error)",
              fontSize: 14,
              fontWeight: 600,
              fontFamily: "var(--font-sans)",
              cursor: busy ? "default" : "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 8,
              opacity: intended === "approve" ? 0.6 : 1,
            }}
          >
            {busy === "reject" && <ButtonSpinner color="var(--state-error)" />}
            Reject
          </button>
        </div>

        <div style={{ marginTop: 16 }}>
          {/* Expiry renders only when the link actually carries the claim (legacy links: none). */}
          <SecureFooter>
            Secure decision link
            {prompt.expiresAt
              ? ` · expires ${formatExpiry(prompt.expiresAt)}`
              : ""}{" "}
            · powered by Naary
          </SecureFooter>
        </div>
      </div>
    </div>,
  );
}
