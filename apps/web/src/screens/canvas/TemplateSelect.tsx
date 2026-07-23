// Template picker for the sendEmail node (docs/design/TEMPLATE-EDITOR.md, Slice 3b) and the
// formTrigger node (Slice 4b). Self-fetches the active environment's content templates of the
// requested `kind` (authored in Settings › Content templates) so a node can reference one by name —
// the worker renders an EMAIL template's blocks instead of the inline body; the form ingress sources
// a FORM template's fields instead of the inline field editor. Uses the ambient X-Environment-Id
// (the graph's active env), like the rest of the canvas.
import { useEffect, useState } from "react";
import { http } from "../../lib/api/http";
import { inputStyle } from "./fields";

/** Only the fields the picker needs from a content template. */
interface TemplateOption {
  id: string;
  name: string;
  kind: "email" | "form";
}

/** Empty-option copy per kind: what "no template" means and where to author one. */
const KIND_COPY: Record<"email" | "form", { none: string; empty: string }> = {
  email: {
    none: "No template — use the inline body below",
    empty: "No email templates yet (Settings › Content templates)",
  },
  form: {
    none: "No template — use the inline fields below",
    empty: "No form templates yet (Settings › Content templates)",
  },
};

export function TemplateSelect({
  value,
  onChange,
  kind = "email",
}: {
  value: string;
  onChange: (templateId: string | undefined) => void;
  /** Which content-template kind to offer (default "email", for the sendEmail node). */
  kind?: "email" | "form";
}) {
  const [templates, setTemplates] = useState<TemplateOption[] | null>(null);

  useEffect(() => {
    let live = true;
    http<TemplateOption[]>(`/content-templates`)
      .then((list) => {
        if (live) setTemplates(list.filter((t) => t.kind === kind));
      })
      .catch(() => {
        if (live) setTemplates([]);
      });
    return () => {
      live = false;
    };
  }, [kind]);

  // A referenced template that isn't in the fetched list (another env / deleted) — keep it
  // selectable so we don't silently drop the node's existing binding.
  const hasCurrent = !value || (templates ?? []).some((t) => t.id === value);

  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value || undefined)}
      style={inputStyle}
      disabled={templates === null}
    >
      <option value="">
        {templates === null
          ? "Loading templates…"
          : templates.length
            ? KIND_COPY[kind].none
            : KIND_COPY[kind].empty}
      </option>
      {(templates ?? []).map((t) => (
        <option key={t.id} value={t.id}>
          {t.name}
        </option>
      ))}
      {value && !hasCurrent && (
        <option value={value}>Current template ({value.slice(0, 8)}…)</option>
      )}
    </select>
  );
}
