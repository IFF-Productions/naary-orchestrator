// Templates section (docs/design/TEMPLATE-EDITOR.md, Slice 3) — author env-scoped Form/Email
// content templates in the drag-and-drop block editor. Email-first; a template is referenced by id
// from a sendEmail node's "template" field. Per-env (a sandbox and a prod template are separate),
// so a small env selector picks which environment's templates you're editing.
import { useEffect, useState } from "react";
import type { TemplateBlock } from "@naary/dsl";
import { Button, TextInput } from "../../../components";
import {
  type Environment,
  HttpError,
  UnauthorizedError,
} from "../../../lib/api";
import { type ContentTemplate, envScoped } from "./env-scoped";
import { ErrorLine, panelStyle, SectionHeader, SectionIntro } from "./shared";
import { TemplateBlockEditor } from "./TemplateBlockEditor";

interface Draft {
  id: string | null;
  name: string;
  subject: string;
  blocks: TemplateBlock[];
}

function friendlyError(e: unknown, fallback: string): string {
  if (e instanceof UnauthorizedError) return "Sign in to edit templates.";
  if (e instanceof HttpError && e.serverMessage) return e.serverMessage;
  return fallback;
}

export function TemplatesSection({ envs }: { envs: Environment[] }) {
  const [envId, setEnvId] = useState<string>(envs[0]?.id ?? "");
  const [templates, setTemplates] = useState<ContentTemplate[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);

  // Default the env selector once envs resolve.
  useEffect(() => {
    if (!envId && envs[0]) setEnvId(envs[0].id);
  }, [envs, envId]);

  useEffect(() => {
    if (!envId) return;
    let live = true;
    setLoaded(false);
    (async () => {
      try {
        const list = await envScoped.listTemplates(envId);
        if (!live) return;
        setTemplates(list);
        setLoaded(true);
        setError(null);
      } catch (e) {
        if (live) {
          // Leave the "Loading…" state even on error, and don't keep a stale list under the error.
          setTemplates([]);
          setLoaded(true);
          setError(friendlyError(e, "Could not load templates."));
        }
      }
    })();
    return () => {
      live = false;
    };
  }, [envId]);

  async function reload() {
    setTemplates(await envScoped.listTemplates(envId));
  }

  async function save() {
    if (!draft) return;
    const name = draft.name.trim();
    if (!name) {
      setError("Template name is required.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const input = {
        kind: "email" as const,
        name,
        subject: draft.subject.trim() || null,
        blocks: draft.blocks,
      };
      if (draft.id) await envScoped.updateTemplate(envId, draft.id, input);
      else await envScoped.createTemplate(envId, input);
      await reload();
      setDraft(null);
    } catch (e) {
      setError(friendlyError(e, "Could not save the template."));
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setBusy(true);
    setError(null);
    try {
      await envScoped.deleteTemplate(envId, id);
      await reload();
    } catch (e) {
      setError(friendlyError(e, "Could not delete the template."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ animation: "naaryFadeUp .25s ease" }}>
      <SectionHeader
        title="Email templates"
        action={
          !draft && (
            <Button
              variant="primary"
              icon="plus"
              disabled={!envId}
              onClick={() =>
                setDraft({ id: null, name: "", subject: "", blocks: [] })
              }
            >
              New template
            </Button>
          )
        }
      />
      <SectionIntro>
        Reusable email bodies built from blocks — reference one from a{" "}
        <strong>Send email</strong> node to send readable, on-brand email
        instead of a raw data dump. Scoped per environment.
      </SectionIntro>

      {error && <ErrorLine>{error}</ErrorLine>}

      {/* Env selector */}
      {envs.length > 1 && (
        <div style={{ display: "flex", gap: 6, margin: "10px 0 14px" }}>
          {envs.map((e) => (
            <button
              key={e.id}
              type="button"
              className={`btn btn-sm ${e.id === envId ? "btn-secondary" : "btn-ghost"}`}
              onClick={() => {
                setDraft(null);
                setEnvId(e.id);
              }}
              style={{ textTransform: "capitalize" }}
            >
              {e.name}
            </button>
          ))}
        </div>
      )}

      {draft ? (
        <div style={{ ...panelStyle, padding: 16 }}>
          <div
            style={{
              display: "flex",
              gap: 10,
              marginBottom: 12,
              flexWrap: "wrap",
            }}
          >
            <div style={{ flex: 1, minWidth: 160 }}>
              <TextInput
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                placeholder="Template name (e.g. Order shipped)"
              />
            </div>
            <div style={{ flex: 1, minWidth: 160 }}>
              <TextInput
                value={draft.subject}
                onChange={(e) =>
                  setDraft({ ...draft, subject: e.target.value })
                }
                placeholder="Subject — {{ order.id }} allowed"
              />
            </div>
          </div>

          <TemplateBlockEditor
            blocks={draft.blocks}
            onChange={(blocks) => setDraft({ ...draft, blocks })}
          />

          <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
            <Button
              variant="primary"
              loading={busy}
              onClick={() => void save()}
            >
              {draft.id ? "Save changes" : "Create template"}
            </Button>
            <Button variant="secondary" onClick={() => setDraft(null)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div style={panelStyle}>
          {!loaded ? (
            <div style={{ padding: 18, color: "var(--ink-3)", fontSize: 13 }}>
              Loading templates…
            </div>
          ) : templates.length === 0 ? (
            <div style={{ padding: 18, color: "var(--ink-3)", fontSize: 13 }}>
              No templates yet — "New template" builds one from blocks.
            </div>
          ) : (
            templates.map((t, i) => (
              <div
                key={t.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  padding: "12px 16px",
                  borderBottom:
                    i < templates.length - 1
                      ? "1px solid var(--line)"
                      : undefined,
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ color: "var(--ink)", fontSize: 13.5 }}>
                    {t.name}
                  </div>
                  <div style={{ fontSize: 11.5, color: "var(--ink-3)" }}>
                    {t.kind} · {t.blocks.length} block
                    {t.blocks.length === 1 ? "" : "s"}
                  </div>
                </div>
                <Button
                  variant="secondary"
                  icon="edit"
                  onClick={() =>
                    setDraft({
                      id: t.id,
                      name: t.name,
                      subject: t.subject ?? "",
                      blocks: t.blocks,
                    })
                  }
                >
                  Edit
                </Button>
                <Button
                  variant="ghost"
                  icon="trash"
                  disabled={busy}
                  onClick={() => void remove(t.id)}
                >
                  Delete
                </Button>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
