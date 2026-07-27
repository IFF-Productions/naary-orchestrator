import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Nullable properties must declare their type EXPLICITLY.
 *
 * `@ApiProperty({ nullable: true })` on a `string | null` field looks complete and is not: Nest's
 * reflection cannot recover a type from a union, so the emitted schema is
 *
 *     { "type": "object", "nullable": true, "example": "GitHub · acme/api" }
 *
 * and every generated client models a nullable string as an OBJECT. Nothing fails — the API keeps
 * returning a string, the spec keeps validating, and only a consumer's types are wrong. It reached
 * 27 properties before anyone noticed: webhook URLs, insights date ranges, the run cursor, emails,
 * tag colours.
 *
 * The fix is always `type: String` (or Number/Boolean) alongside `nullable: true`.
 *
 * THE FINGERPRINT: a property typed `object` that carries a scalar `example` and declares no
 * object shape. A real object property has `properties`/`additionalProperties`, or a `$ref`, or an
 * example that isn't a scalar — so this catches the reflection failure without flagging genuine
 * object fields.
 */

const SPEC = resolve(__dirname, "../openapi.json");

interface Schema {
  type?: string;
  example?: unknown;
  properties?: Record<string, unknown>;
  additionalProperties?: unknown;
  $ref?: string;
}

const spec = JSON.parse(readFileSync(SPEC, "utf8")) as {
  components?: {
    schemas?: Record<string, { properties?: Record<string, Schema> }>;
  };
};
const schemas = spec.components?.schemas ?? {};

describe("openapi: nullable properties declare a real type", () => {
  /** Guards the guard: an unreadable or empty spec must fail, not pass vacuously. */
  it("read a populated spec", () => {
    expect(Object.keys(schemas).length).toBeGreaterThan(50);
  });

  it("has no property typed 'object' that is really a scalar", () => {
    const offenders: string[] = [];
    for (const [name, schema] of Object.entries(schemas)) {
      for (const [prop, ps] of Object.entries(schema.properties ?? {})) {
        const scalarExample =
          typeof ps.example === "string" ||
          typeof ps.example === "number" ||
          typeof ps.example === "boolean";
        const declaresShape =
          ps.properties !== undefined ||
          ps.additionalProperties !== undefined ||
          ps.$ref !== undefined;
        if (ps.type === "object" && scalarExample && !declaresShape) {
          offenders.push(
            `${name}.${prop} (example: ${JSON.stringify(ps.example)})`,
          );
        }
      }
    }
    expect(
      offenders,
      `Add an explicit type to these @ApiProperty declarations — e.g. ` +
        `@ApiProperty({ type: String, nullable: true }). Nest cannot infer one from ` +
        `\`string | null\`, so the spec calls them objects:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
