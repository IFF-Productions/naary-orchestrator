import { useCallback, useEffect, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { Button, Icon, Logo } from "../components";
import { api } from "../lib/api";

/**
 * PUBLIC approve/reject page (the notification-links gap). Reached at `/approve/:workflowId?token=…`,
 * OUTSIDE RequireAuth — a recipient of the pause notification decides WITHOUT opening the app. The
 * token in the URL is the credential (HMAC over the workflowId). A GET fetch is safe (idempotent);
 * the actual decision is a POST behind an explicit button click, so an email prefetch can't approve.
 */
export function ApprovePage() {
  const { workflowId } = useParams<{ workflowId: string }>();
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
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
  }>({});
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<"approved" | "rejected" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!workflowId || !token) {
      setState("invalid");
      return;
    }
    try {
      const p = await api.getApprovalPrompt(workflowId, token);
      if (!p.awaiting) {
        setState("closed");
        return;
      }
      setPrompt({ title: p.title, instructions: p.instructions });
      setState("ready");
    } catch {
      setState("invalid");
    }
  }, [workflowId, token]);

  useEffect(() => {
    void load();
  }, [load]);

  async function decide(decision: "approve" | "reject") {
    if (!workflowId || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.decideApproval(workflowId, token, decision, comment.trim());
      setDone(decision === "approve" ? "approved" : "rejected");
    } catch (e) {
      // A 409 = the run was already decided/closed between load and click.
      setError(
        e instanceof Error && /409/.test(e.message)
          ? "This run is no longer awaiting approval."
          : "Could not record your decision. Try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  const card = (children: React.ReactNode) => (
    <div
      style={{
        minHeight: "100vh",
        background: "var(--bg)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        padding: "48px 20px",
      }}
    >
      <div style={{ marginBottom: 28 }}>
        <Logo />
      </div>
      <div
        style={{
          width: "100%",
          maxWidth: 480,
          background: "var(--card)",
          border: "1px solid var(--line)",
          borderRadius: "var(--radius-lg)",
          boxShadow: "var(--shadow-card)",
          padding: 28,
        }}
      >
        {children}
      </div>
    </div>
  );

  if (state === "loading")
    return card(<div style={{ color: "var(--ink-3)" }}>Loading…</div>);

  if (state === "invalid")
    return card(
      <Notice
        icon="alert"
        title="Invalid or expired link"
        body="This approval link is missing or no longer valid."
      />,
    );

  if (state === "closed")
    return card(
      <Notice
        icon="check-circle"
        title="Already decided"
        body="This run is no longer awaiting approval."
      />,
    );

  if (done)
    return card(
      <Notice
        icon="check-circle"
        title={done === "approved" ? "Approved ✓" : "Rejected"}
        body={`Your decision was recorded. You can close this page.`}
      />,
    );

  return card(
    <>
      <div
        style={{
          fontSize: "var(--text-title)",
          fontWeight: "var(--weight-bold)",
          color: "var(--ink)",
          letterSpacing: "var(--tracking-tight)",
        }}
      >
        {prompt.title ?? "Approval required"}
      </div>
      {prompt.instructions && (
        <div
          style={{
            fontSize: "var(--text-body)",
            color: "var(--ink-2)",
            marginTop: 6,
            lineHeight: "var(--leading-snug)",
          }}
        >
          {prompt.instructions}
        </div>
      )}
      <textarea
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        placeholder="Reason (optional)"
        rows={3}
        aria-label="Reason"
        style={{
          width: "100%",
          marginTop: 18,
          padding: "9px 11px",
          borderRadius: "var(--radius-sm)",
          border: "1px solid var(--line-2)",
          background: "var(--card)",
          color: "var(--ink)",
          fontSize: "var(--text-body)",
          fontFamily: "inherit",
          resize: "vertical",
        }}
      />
      {intended && (
        <div
          style={{
            fontSize: "var(--text-sm)",
            color: "var(--ink-2)",
            marginTop: 14,
          }}
        >
          You chose to{" "}
          <strong style={{ color: "var(--ink)" }}>
            {intended === "approve" ? "approve" : "reject"}
          </strong>{" "}
          this run — add an optional reason and confirm below.
        </div>
      )}
      {error && (
        <div
          style={{
            fontSize: "var(--text-sm)",
            color: "var(--state-error)",
            marginTop: 10,
          }}
        >
          {error}
        </div>
      )}
      <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
        <Button
          variant="positive"
          disabled={busy}
          autoFocus={intended === "approve"}
          onClick={() => void decide("approve")}
          style={{ flex: 1, opacity: intended === "reject" ? 0.6 : 1 }}
        >
          {busy ? "…" : "Approve"}
        </Button>
        <Button
          variant="danger"
          disabled={busy}
          autoFocus={intended === "reject"}
          onClick={() => void decide("reject")}
          style={{ flex: 1, opacity: intended === "approve" ? 0.6 : 1 }}
        >
          {busy ? "…" : "Reject"}
        </Button>
      </div>
    </>,
  );
}

function Notice({
  icon,
  title,
  body,
}: {
  icon: "alert" | "check-circle";
  title: string;
  body: string;
}) {
  return (
    <div style={{ textAlign: "center", padding: "16px 8px" }}>
      <div
        style={{
          width: 46,
          height: 46,
          borderRadius: "var(--radius-full)",
          background: "var(--card-2)",
          color: "var(--ink-2)",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          marginBottom: 14,
        }}
      >
        <Icon name={icon} size={22} />
      </div>
      <div
        style={{
          fontSize: "var(--text-md)",
          fontWeight: "var(--weight-semibold)",
          color: "var(--ink)",
          marginBottom: 6,
        }}
      >
        {title}
      </div>
      <div style={{ fontSize: "var(--text-body)", color: "var(--ink-3)" }}>
        {body}
      </div>
    </div>
  );
}
