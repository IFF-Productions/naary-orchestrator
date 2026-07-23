// Template picker for the sendEmail node (docs/design/TEMPLATE-EDITOR.md, Slice 3b). Self-fetches
// the active environment's EMAIL templates (authored in Settings › Email templates) so a node can
// reference one by name — the worker then renders its blocks instead of the inline body. Uses the
// ambient X-Environment-Id (the graph's active env), like the rest of the canvas.
import { useEffect, useState } from "react";
import { http } from "../../lib/api/http";
import { inputStyle } from "./fields";

/** Only the fields the picker needs from a content template. */
interface TemplateOption {
  id: string;
  name: string;
  kind: "email" | "form";
}

export function TemplateSelect({
  value,
  onChange,
}: {
  value: string;
  onChange: (templateId: string | undefined) => void;
}) {
  const [templates, setTemplates] = useState<TemplateOption[] | null>(null);

  useEffect(() => {
    let live = true;
    http<TemplateOption[]>(`/content-templates`)
      .then((list) => {
        if (live) setTemplates(list.filter((t) => t.kind === "email"));
      })
      .catch(() => {
        if (live) setTemplates([]);
      });
    return () => {
      live = false;
    };
  }, []);

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
            ? "No template — use the inline body below"
            : "No email templates yet (Settings › Email templates)"}
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
