import type { AiBuilderProvider, ProviderOption } from "./providers";

/**
 * "Generate with …" — which model/agent the builder turn runs on.
 *
 * A native `<select>` on purpose: it's one short list, it needs no search, and the native control
 * gets keyboard/screen-reader behaviour and mobile pickers for free. The filterable combobox pattern
 * in this codebase exists for lists a tenant can have hundreds of (workflows); four providers is not
 * that.
 *
 * "Auto" is the default and maps to `null`, i.e. don't send a provider — which leaves the server's own
 * precedence (first VALID credential, API models before `claude-code`) exactly as it was. So mounting
 * this picker changes nothing until someone chooses.
 */
export function ProviderPicker({
  options,
  value,
  onChange,
  disabled,
  hint,
}: {
  options: ProviderOption[];
  /** null ⇒ Auto (server picks). */
  value: AiBuilderProvider | null;
  onChange: (next: AiBuilderProvider | null) => void;
  disabled?: boolean;
  /** Setup guidance when nothing is usable (see providerSetupHint). */
  hint?: string | null;
}) {
  // Nothing configured AND nothing to explain ⇒ credentials haven't loaded yet. Render nothing rather
  // than an empty control that flashes into place.
  if (options.length === 0 && !hint) return null;

  const selected = options.find((o) => o.id === value);

  return (
    <div style={{ marginTop: 8 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          flexWrap: "wrap",
        }}
      >
        <label
          htmlFor="ai-provider"
          style={{ fontSize: "var(--text-2xs)", color: "var(--ink-3)" }}
        >
          Generate with
        </label>
        <select
          id="ai-provider"
          data-testid="ai-provider-select"
          value={value ?? ""}
          disabled={disabled || options.every((o) => !o.selectable)}
          onChange={(e) =>
            onChange((e.target.value || null) as AiBuilderProvider | null)
          }
          style={{
            fontSize: "var(--text-2xs)",
            color: "var(--ink-2)",
            background: "var(--surface)",
            border: "1px solid var(--line-2)",
            borderRadius: "var(--radius-xs)",
            padding: "3px 6px",
            fontFamily: "var(--font-sans)",
            maxWidth: 200,
          }}
        >
          <option value="">Auto</option>
          {options.map((o) => (
            // A configured-but-invalid credential stays VISIBLE and disabled — see providerOptions
            // for why hiding it is the unhelpful choice.
            <option key={o.id} value={o.id} disabled={!o.selectable}>
              {o.selectable ? o.label : `${o.label} (key invalid)`}
            </option>
          ))}
        </select>
        {/* The hint belongs to whatever is actually selected: the model name for a chosen provider,
            or an explanation of what Auto will do — otherwise "Auto" is a black box. */}
        <span
          style={{
            fontSize: "var(--text-2xs)",
            color: "var(--ink-3)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {selected
            ? selected.hint
            : "the workspace's first working provider key"}
        </span>
      </div>
      {hint && (
        <div
          style={{
            marginTop: 6,
            fontSize: "var(--text-2xs)",
            color: "var(--state-error)",
          }}
        >
          {hint}
        </div>
      )}
    </div>
  );
}
