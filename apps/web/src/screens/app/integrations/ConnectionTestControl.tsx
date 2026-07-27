/**
 * "Test connection" control (#701) — the answer to "is this token any good?" without putting an
 * integration node on a canvas first.
 *
 * Why it asks which provider: a connection row carries no provider. `type: "custom"` is
 * provider-agnostic by construction and the catalog provider is chosen at the `integration` NODE, so
 * only the person looking at the screen knows which API this token is for.
 *
 * Why the list is short: the probe may only ever issue a NON-WRITE, ZERO-ARGUMENT read, derived from
 * the catalog itself (`pickConnectionTestAction`). Providers whose cheapest read still needs an id
 * (GitHub needs owner/repo/number) or whose every action writes (Slack) are not offered — they are
 * named in the hint instead, pointing at single-node Test, which is where you can supply values.
 * Offering them here just to return "unknown" would be a worse experience than saying so up front.
 */
import { useMemo, useState } from "react";
import { INTEGRATION_PROVIDERS, pickConnectionTestAction } from "@naary/dsl";
import { Button } from "../../../components";
import { api, type ConnectionTestResult } from "../../../lib/api";

/** The providers a zero-argument read exists for, alphabetical by label. Computed from the catalog
 *  at module load — the same function the API uses to choose the action, so this list can never
 *  offer something the server would then decline. */
const TESTABLE = INTEGRATION_PROVIDERS.filter(
  (p) => pickConnectionTestAction(p.key).kind === "read",
).sort((a, b) => a.label.localeCompare(b.label));

const UNTESTABLE_COUNT = INTEGRATION_PROVIDERS.length - TESTABLE.length;

const selectStyle: React.CSSProperties = {
  fontSize: "var(--text-sm)",
  color: "var(--ink)",
  background: "var(--card-2)",
  border: "1px solid var(--line-mid)",
  borderRadius: "var(--radius-xs)",
  padding: "5px 8px",
  maxWidth: 180,
};

export function ConnectionTestControl({
  tenant,
  connectionId,
  onTested,
}: {
  tenant: string | null;
  connectionId: string;
  /** Called after a test that CHANGED the connection's status, so the list can refetch. */
  onTested?: () => Promise<void> | void;
}) {
  const [provider, setProvider] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ConnectionTestResult | null>(null);

  const hint = useMemo(
    () =>
      `${UNTESTABLE_COUNT} of ${INTEGRATION_PROVIDERS.length} providers (e.g. Slack, GitHub, Jira) have no ` +
      `read-only call that needs no arguments — test those with an integration node on the canvas ` +
      `using single-node Test.`,
    [],
  );

  async function run() {
    if (!tenant || !provider || busy) return;
    setBusy(true);
    setResult(null);
    try {
      const out = await api.testConnection(tenant, connectionId, provider);
      setResult(out);
      // Only refetch when the server actually moved the status — an `unknown` leaves it alone.
      if (out.connectionStatus) await onTested?.();
    } catch {
      // A transport/permission failure is OUR error, not the provider's verdict — never render it
      // as if the token had been rejected.
      setResult({
        ok: false,
        status: "failed",
        httpStatus: null,
        checkedAction: null,
        connectionStatus: null,
        message: "Could not run the test — please try again.",
      });
    } finally {
      setBusy(false);
    }
  }

  const tone =
    result === null
      ? "var(--ink-2)"
      : result.ok
        ? "var(--state-done)"
        : result.status === "unknown"
          ? "var(--ink-2)"
          : "var(--state-error)";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div
        style={{
          display: "flex",
          gap: 8,
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
        <select
          style={selectStyle}
          value={provider}
          aria-label="Provider to test against"
          onChange={(e) => {
            setProvider(e.target.value);
            setResult(null);
          }}
        >
          <option value="">Test against…</option>
          {TESTABLE.map((p) => (
            <option key={p.key} value={p.key}>
              {p.label}
            </option>
          ))}
        </select>
        <Button
          variant="secondary"
          size="sm"
          disabled={busy || !provider || !tenant}
          onClick={() => void run()}
        >
          {busy ? "Testing…" : "Test"}
        </Button>
      </div>
      <div
        style={{
          fontSize: "var(--text-xs)",
          lineHeight: "var(--leading-snug)",
          color: tone,
          maxWidth: 380,
        }}
      >
        {/* Plain text — the message can embed the provider's own error body. */}
        {result ? result.message : hint}
      </div>
    </div>
  );
}
