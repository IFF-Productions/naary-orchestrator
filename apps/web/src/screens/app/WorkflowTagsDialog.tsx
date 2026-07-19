import { useEffect, useState } from "react";
import { Button, Checkbox, Dialog, Tag, TextInput } from "../../components";
import { api, type Tag as TagRow, type TagRef } from "../../lib/api";

/** Fixed palette the UI offers for new tags (any #rrggbb is valid server-side). */
export const TAG_PALETTE = [
  "#6366f1",
  "#0ea5e9",
  "#10b981",
  "#f59e0b",
  "#ef4444",
  "#ec4899",
  "#8b5cf6",
  "#64748b",
];

/**
 * "Edit tags" dialog for ONE workflow: check/uncheck existing tags, create a new tag inline
 * (name + preset color), then save via the replace-set PUT. Tags are organizational metadata
 * only (tenant-wide per workflowKey — the same chips in every environment).
 */
export function WorkflowTagsDialog({
  workflowKey,
  workflowName,
  current,
  allTags,
  onClose,
  onSaved,
  onTagCreated,
}: {
  /** The workflow being edited; null = dialog closed. */
  workflowKey: string | null;
  workflowName: string;
  /** The workflow's current tags (seeds the checkboxes). */
  current: TagRef[];
  /** Every tag in the workspace (the checkbox list). */
  allTags: TagRow[];
  onClose: () => void;
  /** Called with the applied set after a successful save. */
  onSaved: (workflowKey: string, tags: TagRef[]) => void;
  /** Called when a tag is created inline so the parent can extend its list. */
  onTagCreated: (tag: TagRow) => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState<string>(TAG_PALETTE[0]);
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Re-seed the checkbox state each time the dialog opens for a workflow.
  useEffect(() => {
    if (workflowKey) {
      setSelected(new Set(current.map((t) => t.id)));
      setNewName("");
      setErr(null);
    }
    // `current` is intentionally read only when the TARGET workflow changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workflowKey]);

  function toggle(id: string): void {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function createInline(): Promise<void> {
    const name = newName.trim();
    if (!name || creating) return;
    setCreating(true);
    setErr(null);
    try {
      const tag = await api.createTag(name, newColor);
      onTagCreated(tag);
      // Auto-check the fresh tag — creating it here means "put it on this workflow".
      setSelected((prev) => new Set(prev).add(tag.id));
      setNewName("");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not create the tag.");
    } finally {
      setCreating(false);
    }
  }

  async function save(): Promise<void> {
    if (!workflowKey || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const tags = await api.setWorkflowTags(workflowKey, [...selected]);
      onSaved(workflowKey, tags);
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not save tags.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={!!workflowKey}
      onClose={onClose}
      title={`Tags — ${workflowName}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void save()}>
            Save tags
          </Button>
        </>
      }
    >
      <div
        style={{
          fontSize: "var(--text-sm)",
          color: "var(--ink-3)",
          marginBottom: 12,
          lineHeight: "var(--leading-snug)",
        }}
      >
        Tags organize the workflow list — they apply across all environments and
        never affect permissions.
      </div>

      {allTags.length === 0 && (
        <div
          style={{
            fontSize: "var(--text-sm)",
            color: "var(--ink-3)",
            marginBottom: 10,
          }}
        >
          No tags yet — create the first one below.
        </div>
      )}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 6,
          maxHeight: 240,
          overflowY: "auto",
          marginBottom: 14,
        }}
      >
        {allTags.map((t) => (
          <label
            key={t.id}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              cursor: "pointer",
            }}
            onClick={() => toggle(t.id)}
          >
            {/* Display-only: the wrapping label handles the click (an onChange here would
                double-toggle, since the checkbox's click also bubbles to the label). */}
            <Checkbox checked={selected.has(t.id)} />
            <Tag color={t.color ?? undefined}>{t.name}</Tag>
            <span style={{ fontSize: "var(--text-xs)", color: "var(--ink-3)" }}>
              {t.workflowCount} workflow{t.workflowCount === 1 ? "" : "s"}
            </span>
          </label>
        ))}
      </div>

      {/* Inline create: name + a fixed color palette. */}
      <div
        style={{
          borderTop: "1px solid var(--line)",
          paddingTop: 12,
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        <div className="mono-label">New tag</div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <TextInput
            placeholder="Tag name…"
            maxLength={40}
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void createInline()}
            style={{ flex: 1, minWidth: 0 }}
          />
          <Button
            variant="secondary"
            loading={creating}
            disabled={!newName.trim()}
            onClick={() => void createInline()}
          >
            Add
          </Button>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          {TAG_PALETTE.map((c) => (
            <button
              key={c}
              type="button"
              aria-label={`Color ${c}`}
              onClick={() => setNewColor(c)}
              style={{
                width: 18,
                height: 18,
                borderRadius: "50%",
                background: c,
                cursor: "pointer",
                border:
                  newColor === c
                    ? "2px solid var(--ink)"
                    : "2px solid transparent",
                transition: "border-color .12s ease",
              }}
            />
          ))}
        </div>
      </div>

      {err && (
        <div
          style={{
            marginTop: 10,
            fontSize: "var(--text-sm)",
            color: "var(--state-error)",
          }}
        >
          {err}
        </div>
      )}
    </Dialog>
  );
}
