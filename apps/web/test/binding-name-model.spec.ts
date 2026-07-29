import { describe, expect, it } from "vitest";
import {
  bindingNameChoice,
  bindingNameView,
  CUSTOM_OPTION,
  integrationBindingOptions,
} from "../src/screens/canvas/binding-name-model";

const OPTS = [
  { value: "id", label: "Incident id", required: true },
  { value: "From", label: "From (user email)" },
];

describe("bindingNameView", () => {
  it("flags a name the action doesn't have, so it can be given its own option", () => {
    // The case that makes this necessary: fieldBindings survive a change of action, so a row
    // can hold a name this action never had. A <select> whose value matches no <option>
    // renders the FIRST one — the panel would claim a different binding than the graph holds.
    expect(bindingNameView("resolution", OPTS).unknownValue).toBe(true);
  });

  it("a listed name needs no extra option", () => {
    expect(bindingNameView("id", OPTS).unknownValue).toBe(false);
  });

  it("empty is not 'unknown' — it's the placeholder, not a lost value", () => {
    expect(bindingNameView("", OPTS).unknownValue).toBe(false);
    expect(bindingNameView("", OPTS).placeholder).toBe("Choose an argument…");
  });

  it("says so when there is nothing to offer", () => {
    expect(bindingNameView("", []).placeholder).toBe("No arguments to choose");
  });
});

describe("bindingNameChoice", () => {
  it("routes the sentinel to free text and everything else to a name", () => {
    expect(bindingNameChoice(CUSTOM_OPTION)).toEqual({ custom: true });
    expect(bindingNameChoice("id")).toEqual({ name: "id" });
    // The empty choice is a real selection (clear the row), not a switch to custom.
    expect(bindingNameChoice("")).toEqual({ name: "" });
  });
});

describe("integrationBindingOptions", () => {
  const FIELDS = [
    { key: "From", label: "From (user email)", required: false },
    { key: "id", label: "Incident id", required: true },
    { key: "type", label: "Type", required: true, const: "incident_reference" },
  ];

  it("drops const fields — the request builder injects them, so binding one is a no-op", () => {
    expect(integrationBindingOptions(FIELDS).map((o) => o.value)).not.toContain(
      "type",
    );
  });

  it("puts required fields first — those are the ones being looked for", () => {
    expect(integrationBindingOptions(FIELDS).map((o) => o.value)).toEqual([
      "id",
      "From",
    ]);
  });

  it("carries the human label, not the raw key", () => {
    expect(integrationBindingOptions(FIELDS)[0].label).toBe("Incident id");
  });

  it("handles an action with no fields", () => {
    expect(integrationBindingOptions([])).toEqual([]);
  });
});
