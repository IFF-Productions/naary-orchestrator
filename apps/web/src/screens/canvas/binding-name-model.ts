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

export interface BindingNameView {
  /** The name is set but absent from the list — it needs an option of its own. */
  unknownValue: boolean;
  /** Text for the empty choice, which differs when there's nothing to offer. */
  placeholder: string;
}

export function bindingNameView(
  value: string,
  options: BindingOption[],
): BindingNameView {
  const known = options.some((o) => o.value === value);
  return {
    unknownValue: value !== "" && !known,
    placeholder:
      options.length === 0 ? "No arguments to choose" : "Choose an argument…",
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
