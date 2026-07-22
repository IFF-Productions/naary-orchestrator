/**
 * THE FIRST-GRANT WARNING (RBAC-GROUPS.md §4/§8.6): saving a workspace's first grant flips
 * every member and every ungrouped API token to deny-by-default. This is the explicit,
 * checkbox-gated opt-in that guards that irreversible switch. Presentational — the parent
 * owns pendingSave and persists on confirm.
 */
import { Button, Dialog } from "../../../components";

export function FirstGrantDialog({
  open,
  tokenCount,
  ackRestrict,
  busy,
  onAckChange,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  tokenCount: number;
  ackRestrict: boolean;
  busy: boolean;
  onAckChange: (value: boolean) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog
      open={open}
      onClose={onCancel}
      title="This restricts your whole workspace"
      footer={
        <>
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            variant="danger"
            disabled={!ackRestrict || busy}
            loading={busy}
            onClick={onConfirm}
          >
            Save first grant
          </Button>
        </>
      }
    >
      <div
        style={{
          fontSize: "var(--text-body)",
          color: "var(--ink)",
          lineHeight: "var(--leading-snug)",
          marginBottom: 12,
        }}
      >
        This is the workspace&rsquo;s <strong>first grant</strong>. Saving it
        switches every <strong>member</strong> and every{" "}
        <strong>API token</strong> to deny-by-default — from then on they can
        only do what their groups grant.
      </div>
      <div
        style={{
          fontSize: "var(--text-sm)",
          color: "var(--ink-2)",
          lineHeight: "var(--leading-snug)",
          marginBottom: 12,
        }}
      >
        {tokenCount > 0 ? (
          <>
            This workspace has{" "}
            <strong>
              {tokenCount} API token{tokenCount === 1 ? "" : "s"}
            </strong>{" "}
            (CI, MCP, CLI). Ungrouped tokens <strong>stop working</strong> until
            you attach them to a group — use the &ldquo;API tokens&rdquo; picker
            on the group after saving.
          </>
        ) : (
          "This workspace has no API tokens, so only members are affected."
        )}{" "}
        Owners and admins are never restricted, and scheduled/webhook-triggered
        runs keep working.
      </div>
      <label
        style={{
          display: "flex",
          alignItems: "flex-start",
          gap: 9,
          fontSize: "var(--text-sm)",
          color: "var(--ink)",
          cursor: "pointer",
        }}
      >
        <input
          type="checkbox"
          checked={ackRestrict}
          onChange={(e) => onAckChange(e.target.checked)}
          style={{ marginTop: 2 }}
        />
        <span>
          I understand this restricts all members and all API tokens, and that
          ungrouped tokens will stop working until they are added to a group.
        </span>
      </label>
    </Dialog>
  );
}
