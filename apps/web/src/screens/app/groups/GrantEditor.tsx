/**
 * Grant editor (RBAC-GROUPS.md §4/§8, slice G2): environment selector (null = all
 * environments), scope toggle (all workflows / selected + multi-select), and the
 * SIX-verb checkbox matrix. Mirrors the server's §8.3 rule client-side: `create`
 * is selectable only on 'all'-scope grants (disabled + explained otherwise) —
 * draftToPayload also forces it off, so a save can't 400 on the combination.
 */
import { useState } from "react";
import {
  Button,
  Checkbox,
  Dialog,
  SegmentedToggle,
  Tooltip,
} from "../../../components";
import type { Environment } from "../../../lib/api";
import { type GrantDraft, draftProblem } from "../../../lib/permissions-logic";

/** A workflow the 'selected' scope can pick (identity only). */
export interface WorkflowOption {
  workflowKey: string;
  name: string;
}

/** A tag the 'selected' scope can pick (§9 tag-scoped grants). */
export interface TagOption {
  id: string;
  name: string;
  color: string | null;
}

const VERBS: {
  field: keyof Pick<
    GrantDraft,
    "canView" | "canRun" | "canEdit" | "canDelete" | "canShare" | "canCreate"
  >;
  label: string;
  hint: string;
}[] = [
  {
    field: "canView",
    label: "View",
    hint: "See the workflow, its versions and history",
  },
  { field: "canRun", label: "Run", hint: "Start and re-run it manually" },
  {
    field: "canEdit",
    label: "Edit",
    hint: "Save changes, activation, pins, tags",
  },
  { field: "canDelete", label: "Delete", hint: "Delete the workflow" },
  {
    field: "canShare",
    label: "Promote",
    hint: "Copy it toward another environment",
  },
  {
    field: "canCreate",
    label: "Create",
    hint: "Create new workflows in this environment",
  },
];

/** The six-verb checkbox matrix. Pure/presentational — also rendered by Storybook. */
export function GrantMatrix({
  draft,
  onChange,
}: {
  draft: GrantDraft;
  onChange: (next: GrantDraft) => void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      {VERBS.map((v) => {
        // §8.3: create is its OWN permission and only coherent on 'all'-scope grants —
        // a 'selected'-scope creator would immediately lose sight of their new workflow.
        const createBlocked =
          v.field === "canCreate" && draft.scope === "selected";
        const row = (
          <div
            key={v.field}
            role={createBlocked ? undefined : "button"}
            onClick={() =>
              !createBlocked &&
              onChange({ ...draft, [v.field]: !draft[v.field] })
            }
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "7px 8px",
              borderRadius: "var(--radius-sm)",
              cursor: createBlocked ? "not-allowed" : "pointer",
              opacity: createBlocked ? 0.45 : 1,
            }}
          >
            <span onClick={(e) => e.stopPropagation()}>
              <Checkbox
                checked={!createBlocked && draft[v.field]}
                onChange={(next) =>
                  !createBlocked && onChange({ ...draft, [v.field]: next })
                }
              />
            </span>
            <span
              style={{
                width: 74,
                flex: "none",
                fontSize: "var(--text-body)",
                fontWeight: "var(--weight-semibold)",
                color: "var(--ink)",
              }}
            >
              {v.label}
            </span>
            <span style={{ fontSize: "var(--text-xs)", color: "var(--ink-3)" }}>
              {v.hint}
            </span>
          </div>
        );
        return createBlocked ? (
          <Tooltip
            key={v.field}
            label="Create requires the all-workflows scope — a selected-scope creator couldn't see their own new workflow."
          >
            {row}
          </Tooltip>
        ) : (
          row
        );
      })}
      <div
        style={{
          fontSize: "var(--text-xs)",
          color: "var(--ink-3)",
          padding: "4px 8px 0",
        }}
      >
        Run, edit, delete and promote imply view.
      </div>
    </div>
  );
}

/**
 * The add/edit-grant dialog. Owns a local working copy of the draft; Save hands it
 * back to the parent (which shows the first-grant warning + calls the API).
 * Remount per grant (parent keys this by grant id) so `initial` re-seeds cleanly.
 */
export function GrantEditorDialog({
  open,
  title,
  initial,
  envs,
  workflows,
  tags,
  tagGrantsExist,
  busy,
  error,
  onSave,
  onClose,
}: {
  open: boolean;
  title: string;
  initial: GrantDraft;
  envs: Environment[];
  workflows: WorkflowOption[];
  /** The workspace's tags (pickable under 'selected' scope — §9 tag-scoped grants). */
  tags: TagOption[];
  /** Does ANY grant in the workspace already reference a tag? False + a tag picked here
   *  ⇒ this save creates the FIRST TagGrant — show the access-bearing warning. */
  tagGrantsExist: boolean;
  busy: boolean;
  error: string | null;
  onSave: (draft: GrantDraft) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<GrantDraft>(initial);
  const problem = draftProblem(draft);
  const firstTagGrant =
    !tagGrantsExist && draft.scope === "selected" && draft.tagIds.length > 0;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Tooltip label={problem ?? "Save this grant"}>
            <Button
              variant="primary"
              disabled={busy || problem !== null}
              loading={busy}
              onClick={() => onSave(draft)}
            >
              Save grant
            </Button>
          </Tooltip>
        </>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {/* environment (null = all — §8.5) */}
        <div>
          <div style={labelStyle}>Environment</div>
          <select
            value={draft.environmentId ?? ""}
            onChange={(e) =>
              setDraft({ ...draft, environmentId: e.target.value || null })
            }
            style={selectStyle}
          >
            <option value="">All environments</option>
            {envs.map((env) => (
              <option key={env.id} value={env.id}>
                {env.name}
                {env.isDefault ? " (default)" : ""}
              </option>
            ))}
          </select>
        </div>

        {/* scope */}
        <div>
          <div style={labelStyle}>Workflows</div>
          <SegmentedToggle
            options={[
              { value: "all", label: "All workflows" },
              { value: "selected", label: "Selected workflows and/or tags" },
            ]}
            value={draft.scope}
            onChange={(scope) => setDraft({ ...draft, scope })}
          />
          {draft.scope === "selected" && (
            <div
              style={{
                marginTop: 8,
                maxHeight: 180,
                overflowY: "auto",
                border: "1px solid var(--line-2)",
                borderRadius: "var(--radius-sm)",
                padding: 6,
              }}
            >
              {workflows.length === 0 && (
                <div
                  style={{
                    fontSize: "var(--text-xs)",
                    color: "var(--ink-3)",
                    padding: "4px 6px",
                  }}
                >
                  No workflows in this workspace yet.
                </div>
              )}
              {workflows.map((w) => {
                const on = draft.workflowKeys.includes(w.workflowKey);
                return (
                  <div
                    key={w.workflowKey}
                    role="menuitemcheckbox"
                    className="run-row"
                    aria-checked={on}
                    onClick={() =>
                      setDraft({
                        ...draft,
                        workflowKeys: on
                          ? draft.workflowKeys.filter(
                              (k) => k !== w.workflowKey,
                            )
                          : [...draft.workflowKeys, w.workflowKey],
                      })
                    }
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      padding: "5px 6px",
                      borderRadius: "var(--radius-sm)",
                      cursor: "pointer",
                    }}
                  >
                    <Checkbox checked={on} />
                    <span
                      style={{
                        fontSize: "var(--text-sm)",
                        color: "var(--ink)",
                      }}
                    >
                      {w.name}
                    </span>
                    <span
                      className="mono"
                      style={{
                        fontSize: "var(--text-xs)",
                        color: "var(--ink-3)",
                      }}
                    >
                      {w.workflowKey}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
          {/* tag picker (§9 tag-scoped grants): coverage = selected workflows ∪ every
              workflow carrying a selected tag — resolved live, so newly-tagged workflows
              join the grant automatically */}
          {draft.scope === "selected" && (
            <div style={{ marginTop: 10 }}>
              <div style={labelStyle}>Tags</div>
              {tags.length === 0 ? (
                <div
                  style={{
                    fontSize: "var(--text-xs)",
                    color: "var(--ink-3)",
                  }}
                >
                  No tags in this workspace yet — create them on the Workflows
                  screen.
                </div>
              ) : (
                <div
                  style={{
                    maxHeight: 140,
                    overflowY: "auto",
                    border: "1px solid var(--line-2)",
                    borderRadius: "var(--radius-sm)",
                    padding: 6,
                  }}
                >
                  {tags.map((t) => {
                    const on = draft.tagIds.includes(t.id);
                    return (
                      <div
                        key={t.id}
                        role="menuitemcheckbox"
                        className="run-row"
                        aria-checked={on}
                        onClick={() =>
                          setDraft({
                            ...draft,
                            tagIds: on
                              ? draft.tagIds.filter((id) => id !== t.id)
                              : [...draft.tagIds, t.id],
                          })
                        }
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 8,
                          padding: "5px 6px",
                          borderRadius: "var(--radius-sm)",
                          cursor: "pointer",
                        }}
                      >
                        <Checkbox checked={on} />
                        <span
                          style={{
                            width: 9,
                            height: 9,
                            flex: "none",
                            borderRadius: "50%",
                            background: t.color ?? "var(--ink-3)",
                          }}
                        />
                        <span
                          style={{
                            fontSize: "var(--text-sm)",
                            color: "var(--ink)",
                          }}
                        >
                          {t.name}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
              <div
                style={{
                  fontSize: "var(--text-xs)",
                  color: "var(--ink-3)",
                  marginTop: 4,
                }}
              >
                A tag covers every workflow carrying it — now and in the future.
              </div>
            </div>
          )}
          {/* FIRST TagGrant in the workspace: tags flip from metadata to access-bearing */}
          {firstTagGrant && (
            <div
              style={{
                marginTop: 10,
                padding: "8px 10px",
                borderRadius: "var(--radius-sm)",
                background: "var(--paused-soft)",
                color: "var(--state-paused)",
                fontSize: "var(--text-sm)",
                lineHeight: "var(--leading-snug)",
              }}
            >
              <strong>Tags become access-bearing</strong> — this is the
              workspace&rsquo;s first tag-scoped grant. From now on, editing a
              workflow&rsquo;s tags will require the Promote permission
              (otherwise an editor could grant access just by tagging).
            </div>
          )}
        </div>

        {/* the six-verb matrix */}
        <div>
          <div style={labelStyle}>Permissions</div>
          <GrantMatrix draft={draft} onChange={setDraft} />
        </div>

        {error && (
          <div
            style={{ fontSize: "var(--text-sm)", color: "var(--state-error)" }}
          >
            {error}
          </div>
        )}
      </div>
    </Dialog>
  );
}

const labelStyle: React.CSSProperties = {
  fontSize: "var(--text-xs)",
  fontWeight: "var(--weight-semibold)",
  color: "var(--ink-2)",
  marginBottom: 6,
};

const selectStyle: React.CSSProperties = {
  width: "100%",
  padding: "8px 10px",
  borderRadius: "var(--radius-sm)",
  border: "1px solid var(--line-2)",
  background: "var(--card)",
  color: "var(--ink)",
  fontSize: "var(--text-body)",
};
