import { describe, expect, it } from "vitest";
import { isPollutingKey, hasForbiddenPathSegment } from "../src/mcp-args";
import { nodeConfigSchema } from "../src/registry";
import { templateBlocksSchema } from "../src/template-blocks";

/**
 * Save-gate for LITERAL data keys that a node writes into a plain object (issue #761).
 *
 * The bug being closed is silent data loss, not pollution. `data["__proto__"] = "some string"` is a
 * **no-op** in JavaScript — the value is discarded and nothing throws. So a form field keyed
 * `__proto__` validated, satisfied its required check, started the run, and arrived at the workflow
 * absent, with no error anywhere. JSON Schema can't warn a client either: ajv skips such a property
 * entirely, applying neither `pattern` nor `required`.
 *
 * Rejected at SAVE because it's an authoring mistake — failing the visitor for the author's typo would
 * be the wrong end.
 */
const FORBIDDEN = ["__proto__", "constructor", "prototype"];

describe("isPollutingKey vs hasForbiddenPathSegment", () => {
  it.each(FORBIDDEN)("treats %s as polluting", (k) => {
    expect(isPollutingKey(k)).toBe(true);
  });

  it.each(["email", "name", "proto", "__proto", "Constructor", "prototypes"])(
    "leaves %s alone",
    (k) => {
      expect(isPollutingKey(k)).toBe(false);
    },
  );

  /**
   * The reason the two functions exist separately. A binding key is a dotted PATH that a setter walks,
   * so `user.__proto__.x` must be refused. A form field key is a single LITERAL name that may
   * legitimately contain a dot — splitting it would refuse a perfectly safe flat key.
   */
  it("does not split a literal key on dots, unlike the path check", () => {
    expect(isPollutingKey("user.__proto__")).toBe(false);
    expect(hasForbiddenPathSegment("user.__proto__")).toBe(true);
    // …and a flat key containing a dot stays usable as a form field.
    expect(isPollutingKey("user.email")).toBe(false);
  });
});

describe("formTrigger field keys", () => {
  const schema = nodeConfigSchema("formTrigger");
  const withKey = (key: string) =>
    schema.safeParse({
      fields: [{ key, label: "L", type: "text" }],
    });

  it("accepts ordinary keys, including one containing a dot", () => {
    for (const key of ["email", "first_name", "user.email", "q1"]) {
      expect(withKey(key).success, key).toBe(true);
    }
  });

  it.each(FORBIDDEN)("rejects a field keyed %s", (key) => {
    const result = withKey(key);
    expect(result.success).toBe(false);
    // The message must say WHY, or an author just tries a different spelling.
    expect(JSON.stringify(result.error?.issues)).toMatch(
      /silently discarded|reserved/i,
    );
  });

  it("rejects the bad key even among valid ones", () => {
    expect(
      schema.safeParse({
        fields: [
          { key: "email", label: "Email", type: "email" },
          { key: "__proto__", label: "Sneaky", type: "text" },
        ],
      }).success,
    ).toBe(false);
  });
});

describe("form TEMPLATE field blocks", () => {
  /**
   * A template's `field` blocks BECOME the submitted field set (`fieldsFromBlocks` in apps/api), so they
   * reach exactly the code path where the write is discarded. Guarding only the inline `fields` would
   * have left this route wide open — the same "two sources, one validator" shape that has bitten this
   * feature before.
   */
  const block = (key: string) => [
    {
      id: "b1",
      type: "field" as const,
      key,
      label: "L",
      fieldType: "text" as const,
      required: false,
    },
  ];

  it("accepts an ordinary key", () => {
    expect(templateBlocksSchema.safeParse(block("email")).success).toBe(true);
  });

  it.each(FORBIDDEN)("rejects a field block keyed %s", (key) => {
    expect(templateBlocksSchema.safeParse(block(key)).success).toBe(false);
  });
});

describe("renameKeys targets", () => {
  const schema = nodeConfigSchema("renameKeys");

  it("accepts an ordinary rename", () => {
    expect(
      schema.safeParse({ from: "n1", rename: { old: "new" } }).success,
    ).toBe(true);
  });

  /**
   * The VALUE is the key this node writes, so it takes the same guard: renaming something to
   * `__proto__` discards it silently, exactly like the form field case.
   */
  it.each(FORBIDDEN)("rejects renaming a key TO %s", (target) => {
    expect(
      schema.safeParse({ from: "n1", rename: { ok: target } }).success,
    ).toBe(false);
  });

  /** The source side only ever READS, so it stays unconstrained. */
  it.each(FORBIDDEN)(
    "still allows %s as the source key being renamed",
    (src) => {
      expect(
        schema.safeParse({ from: "n1", rename: { [src]: "safe" } }).success,
      ).toBe(true);
    },
  );
});
