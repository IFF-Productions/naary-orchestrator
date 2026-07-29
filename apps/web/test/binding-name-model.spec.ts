import { describe, expect, it } from "vitest";
import {
  ARGUMENT_COPY,
  bindingNameChoice,
  bindingNameView,
  CUSTOM_OPTION,
  integrationBindingOptions,
  MCP_TOOL_COPY,
  mcpToolBindingOptions,
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

describe("copy", () => {
  // The control now names two different things — an argument, and the MCP tool a node calls — and
  // the copy is the only difference. ARGUMENT_COPY is the default, so #915's strings must survive
  // the parameterization byte for byte.
  it("defaults to the argument wording", () => {
    expect(bindingNameView("", OPTS).placeholder).toBe("Choose an argument…");
    expect(bindingNameView("", []).placeholder).toBe("No arguments to choose");
    expect(ARGUMENT_COPY.unlisted("resolution")).toBe(
      "resolution (not an argument of this action)",
    );
    expect(ARGUMENT_COPY.custom).toBe("Custom argument…");
  });

  it("says 'tool' when naming a tool, and keeps unknownValue meaning the same thing", () => {
    const view = bindingNameView("stale_tool", OPTS, MCP_TOOL_COPY);
    expect(view.placeholder).toBe("Choose a tool…");
    // The load-bearing rule is copy-independent: a value the list doesn't hold still gets its own
    // option, so a tool name left over from another connection stays visible AND stays set.
    expect(view.unknownValue).toBe(true);
    expect(bindingNameView("", [], MCP_TOOL_COPY).placeholder).toBe(
      "No tools to choose",
    );
    expect(MCP_TOOL_COPY.unlisted("stale_tool")).toBe(
      "stale_tool (not offered by this server)",
    );
  });
});

describe("mcpToolBindingOptions", () => {
  const SCHEMA = {
    type: "object",
    properties: {
      body: { type: "string" },
      owner: { type: "string" },
      issue_number: { type: "number" },
    },
    required: ["owner", "issue_number"],
  };

  it("offers the schema's own property names — the whole point", () => {
    expect(mcpToolBindingOptions(SCHEMA).map((o) => o.value)).toEqual([
      "owner",
      "issue_number",
      "body",
    ]);
  });

  it("marks the schema's required properties, and puts them first", () => {
    const opts = mcpToolBindingOptions(SCHEMA);
    expect(opts.slice(0, 2).every((o) => o.required)).toBe(true);
    expect(opts[2].required).toBe(false);
  });

  it("keeps the property NAME in the label — the name is what gets stored", () => {
    // Annotated with the type, never replaced by a prettier title: a label that hid the key would
    // make the author pick a name they can't see.
    expect(mcpToolBindingOptions(SCHEMA)[0].label).toBe("owner (string)");
  });

  it("yields nothing rather than guessing, for every shape it declines to read", () => {
    // No schema at all (an unlisted tool, or a server that ships none), a non-object, and the
    // $ref/allOf forms we deliberately do NOT resolve. Empty is CORRECT here: the control falls
    // back to free text, so an author is never blocked by a schema we chose not to interpret.
    expect(mcpToolBindingOptions(undefined)).toEqual([]);
    expect(mcpToolBindingOptions(null)).toEqual([]);
    expect(mcpToolBindingOptions("nope")).toEqual([]);
    expect(mcpToolBindingOptions([1, 2])).toEqual([]);
    expect(mcpToolBindingOptions({ type: "object" })).toEqual([]);
    expect(mcpToolBindingOptions({ properties: [] })).toEqual([]);
    expect(
      mcpToolBindingOptions({ allOf: [{ properties: { a: {} } }] }),
    ).toEqual([]);
  });

  it("survives a hostile-ish schema: a mistyped `required`, a non-object property spec", () => {
    const opts = mcpToolBindingOptions({
      properties: { a: "not-a-schema", b: { type: 7 } },
      required: "owner",
    });
    expect(opts.map((o) => o.value)).toEqual(["a", "b"]);
    // No type it can state plainly ⇒ the bare name, never an invented one.
    expect(opts.map((o) => o.label)).toEqual(["a", "b"]);
    expect(opts.every((o) => o.required === false)).toBe(true);
  });
});
