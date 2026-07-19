// Code Agent (Claude Code) credential + "Run test" card for the Integrations screen.
import { useState } from "react";
import { getNodeOutput } from "@naary/dsl";
import { Button, StatusPill } from "../../../components";
import { api } from "../../../lib/api";
import { isTerminal } from "../../../lib/run-status";

/**
 * Code Agent (Claude Code) card. Holds a DEDICATED `claude-code` credential — separate from the
 * Anthropic model-provider key — because Claude Code can auth with a subscription setup-token
 * (`claude setup-token`), not just an API key. Also runs a MINIMAL read-only codeAgent run to
 * verify the `claude` CLI + this credential work end-to-end (the real CLI subprocess in the worker).
 */
export function CodeAgentCard({
  tenant,
  hasKey,
  keyValid,
  onSaved,
}: {
  tenant: string | null;
  hasKey: boolean;
  keyValid: boolean;
  onSaved: () => void;
}) {
  const [phase, setPhase] = useState<"idle" | "running" | "ok" | "fail">(
    "idle",
  );
  const [detail, setDetail] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  // Credential entry (the dedicated claude-code slot).
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState("");
  const [savingKey, setSavingKey] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);

  async function saveKey() {
    if (!tenant || !token.trim()) return;
    setSavingKey(true);
    setSaveErr(null);
    try {
      await api.saveCredential(tenant, "claude-code", token.trim());
      setToken("");
      setOpen(false);
      onSaved();
    } catch {
      setSaveErr(
        "Token rejected — paste an API key (sk-ant-api…) or a setup-token (sk-ant-oat…).",
      );
    } finally {
      setSavingKey(false);
    }
  }

  async function runTest() {
    setPhase("running");
    setDetail(null);
    setRunId(null);
    try {
      const { workflowId } = await api.testCodeAgent();
      setRunId(workflowId);
      // Poll until the run reaches a terminal state (or time out).
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const s = await api.getState(workflowId).catch(() => null);
        if (!s || !isTerminal(s.status)) continue;
        if (s.status === "completed") {
          // Typed read: getNodeOutput narrows ctx.codeAgent to its map shape
          // ({ status, output: { result, tool }, costUsd }) — the ".result vs
          // .output.result" bug is now a compile error, not a silent undefined.
          const out = getNodeOutput(s.ctx, "codeAgent", "codeAgent")?.output
            .result;
          setPhase("ok");
          setDetail(
            out ? `Claude replied: “${out.trim().slice(0, 80)}”` : "Completed.",
          );
        } else {
          // The run can end in several terminal states (failed, budget_exceeded,
          // circuit_open, invalid_graph, …); don't guess the cause — point at the run.
          setPhase("fail");
          setDetail(`Test run ${s.status}. Open the run for details.`);
        }
        return;
      }
      setPhase("fail");
      setDetail("Timed out waiting for the test run.");
    } catch (err) {
      // Surface the real start error (budget cap, auth, …) instead of a generic string.
      setPhase("fail");
      setDetail(
        err instanceof Error
          ? `Could not start the test run: ${err.message}`
          : "Could not start the test run.",
      );
    }
  }

  const resultColor =
    phase === "ok" ? "var(--state-done)" : "var(--state-error)";

  return (
    <div
      style={{
        background: "var(--card)",
        border: "1px solid var(--line)",
        borderRadius: "var(--radius-lg)",
        boxShadow: "var(--shadow-card)",
        padding: 16,
        maxWidth: 560,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span
          style={{
            width: 30,
            height: 30,
            borderRadius: 8,
            background: "var(--node-agent)",
            color: "#fff",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontWeight: "var(--weight-bold)",
            flex: "none",
          }}
        >
          ⌘
        </span>
        <div style={{ flex: 1 }}>
          <div
            style={{
              fontSize: "var(--text-body)",
              fontWeight: "var(--weight-semibold)",
              color: "var(--ink)",
            }}
          >
            Claude Code
          </div>
          <div style={{ fontSize: "var(--text-xs)", color: "var(--ink-3)" }}>
            The Code Agent node — runs the <code>claude</code> CLI. Uses a{" "}
            <strong>dedicated</strong> Claude Code credential (separate from
            your Anthropic key).
          </div>
        </div>
        {keyValid ? (
          <StatusPill state="done" label="Key set" />
        ) : hasKey ? (
          <StatusPill state="error" label="Key invalid" />
        ) : (
          <StatusPill state="idle" label="No key" />
        )}
      </div>

      {open ? (
        <div style={{ marginTop: 12, animation: "naaryFadeUp .2s ease" }}>
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="sk-ant-api… (API key) or sk-ant-oat… (setup-token)"
            style={{
              width: "100%",
              padding: "8px 10px",
              borderRadius: "var(--radius-sm)",
              border: "1px solid var(--line-2)",
              background: "var(--card)",
              color: "var(--ink)",
              fontSize: "var(--text-body)",
            }}
          />
          <div
            style={{
              fontSize: "var(--text-xs)",
              color: "var(--ink-3)",
              marginTop: 6,
            }}
          >
            Run <code>claude setup-token</code> for a subscription token, or
            paste an Anthropic API key. Stored encrypted; never echoed back.
          </div>
          {saveErr && (
            <div
              style={{
                fontSize: "var(--text-sm)",
                color: "var(--state-error)",
                marginTop: 6,
              }}
            >
              {saveErr}
            </div>
          )}
          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
            <Button
              variant="primary"
              loading={savingKey}
              disabled={savingKey || !token.trim()}
              onClick={() => void saveKey()}
            >
              {savingKey ? "Saving…" : "Save credential"}
            </Button>
            <Button
              variant="secondary"
              disabled={savingKey}
              onClick={() => {
                setOpen(false);
                setToken("");
                setSaveErr(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : null}

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          marginTop: 14,
          flexWrap: "wrap",
        }}
      >
        <Button
          variant={hasKey ? "secondary" : "primary"}
          icon="key"
          disabled={!tenant}
          onClick={() => setOpen((v) => !v)}
        >
          {hasKey ? "Update credential" : "Set credential"}
        </Button>
        <Button
          variant={hasKey ? "primary" : "secondary"}
          icon="play"
          loading={phase === "running"}
          disabled={phase === "running" || !hasKey}
          title={
            hasKey
              ? keyValid
                ? "Run a read-only test"
                : "Run the test to surface the invalid credential"
              : "Set a Claude Code credential first"
          }
          onClick={() => void runTest()}
        >
          {phase === "running" ? "Testing…" : "Run test"}
        </Button>
        {detail && (
          <span
            style={{
              fontSize: "var(--text-sm)",
              color: phase === "running" ? "var(--ink-3)" : resultColor,
            }}
          >
            {phase === "ok" ? "✓ " : phase === "fail" ? "✗ " : ""}
            {detail}
            {runId && (phase === "ok" || phase === "fail") && (
              <>
                {" "}
                <a
                  href={`/app/runs/${runId}`}
                  style={{ color: "var(--brand)" }}
                >
                  view run
                </a>
              </>
            )}
          </span>
        )}
      </div>
    </div>
  );
}
