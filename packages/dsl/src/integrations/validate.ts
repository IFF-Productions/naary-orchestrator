/**
 * The save gate (design §6): provider and action exist, a connection is set, every required
 * field is supplied — statically or by a binding — every path `{placeholder}` has a supplied
 * path field, and no retired field key is still configured.
 *
 * Separate from `./build-request` because the two answer different questions at different times:
 * this one returns a correctable 400 while the author is still on the canvas, the builder throws
 * mid-run. They must nonetheless agree on what "supplied" means, which is why both take
 * `isEmptyFieldValue` from `../integration-fields` instead of each keeping its own idea of empty.
 */
import {
  findPlaceholderFieldValue,
  isBlankFieldValue,
} from "../integration-fields";
import { bindingNamesSource } from "../mcp-args";
import type { IntegrationNodeConfig } from "../types";
import { getIntegrationAction, getIntegrationProvider } from "./lookup";

/**
 * Catalog-aware save-gate validation (design §6). Returns an error string or null.
 * Checks the provider/action exist, every required field is supplied (statically or via a
 * binding), and every path `{placeholder}` is a supplied path field. A correctable 400.
 */
export function validateIntegrationConfig(
  config: IntegrationNodeConfig,
): string | null {
  const provider = getIntegrationProvider(config.provider);
  if (!provider) return `unknown integration provider '${config.provider}'`;
  const action = getIntegrationAction(config.provider, config.action);
  if (!action) {
    return `unknown action '${config.action}' for provider '${config.provider}'`;
  }
  if (!config.connectionId) {
    return `integration '${config.provider}.${config.action}' needs a connectionId`;
  }
  // A field is "supplied" only by a binding (resolved at runtime) or a NON-EMPTY static value.
  // A present-but-empty static value ("" / null / [] ) counts as MISSING — otherwise it would
  // pass the gate but be dropped by buildIntegrationRequest (which omits empties), sending a
  // malformed path/body instead of failing fast here. "Empty" is judged ALL THE WAY DOWN
  // (`isBlankFieldValue`, not `isEmptyFieldValue`), because a `json` field's emptiness hides one
  // level in: Notion's `parent` arrives as `{ "database_id": "" }`, which has a key and so used to
  // count as filled.
  // Only a binding that NAMES A SOURCE counts as supplying the field. An unfinished row used
  // to satisfy this gate and then blank the value at run time — the save said fine, the run
  // said "empty". Now an unfinished row leaves the field to its static value, and if there
  // isn't one the save fails here, naming the field, instead of the run failing later.
  const hasBinding = (key: string): boolean =>
    config.fieldBindings != null &&
    key in config.fieldBindings &&
    bindingNamesSource(config.fieldBindings[key]);
  const hasStaticValue = (key: string): boolean =>
    config.fields != null &&
    key in config.fields &&
    !isBlankFieldValue(config.fields[key]);
  const supplied = (key: string): boolean =>
    hasBinding(key) ||
    hasStaticValue(key) ||
    // A const field is supplied BY THE CATALOG (buildIntegrationRequest injects it), so
    // never ask the user for it.
    action.fields.some((f) => f.key === key && f.const !== undefined);

  // A key this action USED to take, still sitting in a saved config (#944). Checked BEFORE the
  // generic missing-field loop so the author reads what moved instead of the name of a field they
  // have never seen. Only while the replacement is unsupplied: once they have filled the new field
  // in, the stale key is inert (buildIntegrationRequest only ever reads declared fields), and
  // failing the save over inert data would strand a node that is already correct.
  for (const retired of action.retiredFields ?? []) {
    const stillConfigured =
      (config.fields != null && retired.key in config.fields) ||
      (config.fieldBindings != null && retired.key in config.fieldBindings);
    if (!stillConfigured) continue;
    if (retired.replacedBy && supplied(retired.replacedBy)) continue;
    return (
      `integration '${config.provider}.${config.action}' still configures '${retired.key}', which ` +
      `this action no longer takes${retired.replacedBy ? ` — it is now '${retired.replacedBy}'` : ""}. ` +
      retired.note
    );
  }
  // An UNFILLED SLOT — `"<your-board-id>"` — is not a value, and until now it was the only kind of
  // unfilled field nothing anywhere reported. It is a non-empty string, so `supplied()` accepts it,
  // the node looks configured on the canvas, the save goes through, and `buildIntegrationRequest`
  // sends the literal text to the provider, which answers 400 on the first run. Reported here, so
  // the canvas issues panel, the dry run and the run-time activity all name it at once — and the
  // message QUOTES the slot, because `<your-board-id>` says what to go and find better than any
  // sentence we could write. Checked across every configured field, not just the required ones:
  // an optional field with a slot in it is sent too, and fails the same way.
  for (const [key, value] of Object.entries(config.fields ?? {})) {
    const slot = findPlaceholderFieldValue(value);
    if (slot) {
      return (
        `integration '${config.provider}.${config.action}' field '${key}' is still a placeholder ` +
        `(${slot}) — replace it with the real value, or bind it to an earlier node.`
      );
    }
  }
  for (const field of action.fields) {
    if (field.required && !supplied(field.key)) {
      return `integration '${config.provider}.${config.action}' is missing required field '${field.key}'`;
    }
  }
  // Every path placeholder must be a declared path field that is supplied.
  const placeholders = [...action.pathTemplate.matchAll(/\{([^}]+)\}/g)].map(
    (m) => m[1],
  );
  for (const ph of placeholders) {
    const field = action.fields.find((f) => f.key === ph && f.in === "path");
    if (!field) {
      return `integration '${config.provider}.${config.action}' path placeholder '{${ph}}' has no matching path field (catalog bug)`;
    }
    if (!supplied(ph)) {
      return `integration '${config.provider}.${config.action}' is missing path field '${ph}'`;
    }
  }
  return null;
}
