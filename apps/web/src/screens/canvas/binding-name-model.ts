/**
 * Deciding what the argument-name control shows in the bindings editor.
 *
 * Pure, so the rule that matters can be tested without a DOM: **a name the option list doesn't
 * contain must still be shown and still be kept**. That happens constantly and through no fault
 * of the author — switching an integration's action swaps the whole field set while the existing
 * `fieldBindings` survive, and a custom name is legitimate besides. A `<select>` whose `value`
 * matches no `<option>` silently renders its FIRST option, so without an explicit option carrying
 * the real name the panel would claim the row is bound to something else while the graph says
 * otherwise — and the next edit would make the lie true.
 */

/** Sentinel for "let me type a name that isn't listed". Not a legal argument name. */
export const CUSTOM_OPTION = "__custom__";

/** One offerable argument — `value` is the name stored in the binding map. */
export interface BindingOption {
  value: string;
  /** What the author reads; for an integration this is the field's human label. */
  label: string;
  /** Marks it as required by the action, so the list says which ones matter. */
  required?: boolean;
}

/**
 * The words one pick-or-type control uses. Parameterized because the SAME control now names two
 * different things — an argument of a node, and the MCP tool the node calls — and the copy is the
 * only difference between them. `ARGUMENT_COPY` is the default, so every existing call site keeps
 * the exact strings #915 shipped.
 */
export interface ChoiceCopy {
  /** Empty choice when there ARE options to offer. */
  placeholder: string;
  /** Empty choice when the list is empty — says why, rather than looking broken. */
  emptyPlaceholder: string;
  /** Label for the option that carries a value the list doesn't contain. */
  unlisted: (value: string) => string;
  /** Label for the escape hatch into free text. */
  custom: string;
  /** Placeholder for the free-text input. */
  inputPlaceholder: string;
  /** Accessible name — the same on both the select and the input, so a test can read either. */
  ariaLabel: string;
}

/** Naming an ARGUMENT of a node. These strings are #915's, unchanged. */
export const ARGUMENT_COPY: ChoiceCopy = {
  placeholder: "Choose an argument…",
  emptyPlaceholder: "No arguments to choose",
  unlisted: (v) => `${v} (not an argument of this action)`,
  custom: "Custom argument…",
  inputPlaceholder: "argument name",
  ariaLabel: "Argument name",
};

/**
 * Naming the MCP TOOL a node calls. "not offered by this server" rather than "not an argument of
 * this action" because the two failure modes read differently: a tool this server doesn't list is
 * usually a stale name or an unreachable server, not a typo in a field key.
 */
export const MCP_TOOL_COPY: ChoiceCopy = {
  placeholder: "Choose a tool…",
  emptyPlaceholder: "No tools to choose",
  unlisted: (v) => `${v} (not offered by this server)`,
  custom: "Custom tool name…",
  inputPlaceholder: "tool name",
  ariaLabel: "Tool name",
};

export interface BindingNameView {
  /** The name is set but absent from the list — it needs an option of its own. */
  unknownValue: boolean;
  /** Text for the empty choice, which differs when there's nothing to offer. */
  placeholder: string;
}

export function bindingNameView(
  value: string,
  options: BindingOption[],
  copy: ChoiceCopy = ARGUMENT_COPY,
): BindingNameView {
  const known = options.some((o) => o.value === value);
  return {
    unknownValue: value !== "" && !known,
    placeholder:
      options.length === 0 ? copy.emptyPlaceholder : copy.placeholder,
  };
}

/** What picking an option means: a chosen name, or a switch to free text. */
export function bindingNameChoice(
  option: string,
): { custom: true } | { name: string } {
  return option === CUSTOM_OPTION ? { custom: true } : { name: option };
}

/**
 * The catalog fields an integration action can be BOUND to.
 *
 * `const` fields are excluded because the request builder injects them (they're API type
 * discriminators like `incident.type`); offering one would invite a binding that is silently
 * overwritten. Required fields sort first — those are the ones an author is looking for.
 */
export function integrationBindingOptions(
  fields: {
    key: string;
    label: string;
    required?: boolean;
    const?: unknown;
  }[],
): BindingOption[] {
  return fields
    .filter((f) => f.const === undefined)
    .map((f) => ({ value: f.key, label: f.label, required: f.required }))
    .sort((a, b) => Number(!!b.required) - Number(!!a.required));
}

/**
 * The arguments an MCP tool can be BOUND to, read out of the `inputSchema` its server advertised.
 *
 * Same job as `integrationBindingOptions`, different source of truth: the integration catalog is
 * ours and complete, an MCP tool's schema is the server's and may be anything. So this reads only
 * what is unambiguous — the top-level `properties` keys and `required` — and deliberately does NOT
 * resolve `$ref` / `allOf` / `anyOf` / `oneOf`. A partial or empty list is the CORRECT outcome
 * there: the control keeps its "Custom argument…" hatch, so an author is never blocked by a schema
 * we chose not to interpret. Don't build a resolver here — it would turn an authoring convenience
 * into a JSON-Schema engine that has to be right about a spec we don't control.
 *
 * The label carries the property NAME (annotated with its type when the schema states one plainly),
 * never a prettified title instead — the name is what gets stored, so it must stay readable.
 */
export function mcpToolBindingOptions(inputSchema: unknown): BindingOption[] {
  if (!isRecord(inputSchema)) return [];
  const properties = inputSchema.properties;
  if (!isRecord(properties)) return [];
  const required = new Set(
    Array.isArray(inputSchema.required)
      ? inputSchema.required.filter((r): r is string => typeof r === "string")
      : [],
  );
  return Object.keys(properties)
    .map((key) => {
      const spec = properties[key];
      const type =
        isRecord(spec) && typeof spec.type === "string" ? spec.type : "";
      return {
        value: key,
        label: type ? `${key} (${type})` : key,
        required: required.has(key),
      };
    })
    .sort((a, b) => Number(!!b.required) - Number(!!a.required));
}

/** A plain JSON object — anything else in a remote schema is something we decline to read. */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
