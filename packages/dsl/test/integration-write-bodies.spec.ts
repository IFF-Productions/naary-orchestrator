import { describe, expect, it } from "vitest";
import {
  INTEGRATION_CATALOG,
  type IntegrationAction,
  type IntegrationField,
  buildIntegrationRequest,
} from "../src/integrations";

/**
 * Every WRITE action's body, built three ways (#813).
 *
 * `integration-catalog-openapi.drift.spec.ts` compares each `bodyPath` against the provider's own
 * spec, but it reads the CATALOG — it never builds a request. That leaves a whole bug class
 * invisible, because the builder's behaviour depends on which fields the author actually filled
 * in: `buildIntegrationRequest` drops empty optionals, and then injects `const` discriminators in
 * a second pass that deliberately SKIPS a const whose parent object nobody else populated. Build
 * every action with every field set and both of those code paths stay dark.
 *
 * So each action is built three ways — FULL (every field), REQUIRED (path + required fields only,
 * which is the smallest legal call and the one an author most often makes), and MINIMAL (path
 * fields only, the emptiest thing the builder must survive) — and the invariants below are checked
 * on all three.
 *
 * The invariant that matters is the CONJURED ENVELOPE: an object in the payload whose every leaf
 * came from a catalog `const`. PagerDuty's `incident.body.type: "incident_body"` is the live
 * example — sent on its own it means "here is a body object" while carrying no body, and PagerDuty
 * rejects it. The guard for that lives in `buildIntegrationRequest`'s second pass; this file is
 * what stops the next `const` field from being added a level too high, where the guard's
 * `parent.includes(".")` test doesn't reach.
 */

/** `{a: {b: 1}}` → `["a.b"]`. Arrays are values, not structure — a list of objects is data. */
function leafPaths(node: unknown, prefix = "", out: string[] = []): string[] {
  if (node === null || typeof node !== "object" || Array.isArray(node)) {
    out.push(prefix);
    return out;
  }
  for (const [key, value] of Object.entries(node as Record<string, unknown>))
    leafPaths(value, prefix ? `${prefix}.${key}` : key, out);
  return out;
}

/** Every dotted path at which the built body holds an OBJECT — the envelopes. */
function objectPaths(node: unknown, prefix = "", out: string[] = []): string[] {
  if (node === null || typeof node !== "object" || Array.isArray(node))
    return out;
  if (prefix) out.push(prefix);
  for (const [key, value] of Object.entries(node as Record<string, unknown>))
    objectPaths(value, prefix ? `${prefix}.${key}` : key, out);
  return out;
}

const bodyPathOf = (f: IntegrationField): string => f.bodyPath ?? f.key;

function sampleValue(field: IntegrationField): unknown {
  switch (field.type) {
    case "number":
      return 42;
    case "boolean":
      return true;
    case "string[]":
      return ["one", "two"];
    case "json":
      return { sample: "value" };
    default:
      return `${field.key}-value`;
  }
}

type Shape = "FULL" | "REQUIRED" | "MINIMAL";

/** The field values an author would have supplied for a given shape. `const` fields are never
 *  included: the catalog injects those itself, and a caller-supplied value is ignored. */
function valuesFor(
  action: IntegrationAction,
  shape: Shape,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of action.fields) {
    if (field.const !== undefined) continue;
    const include =
      field.in === "path" || // always: an empty path segment is a hard build error, by design
      shape === "FULL" ||
      (shape === "REQUIRED" && field.required);
    if (include) out[field.key] = sampleValue(field);
  }
  return out;
}

/** Body-bearing writes: POST/PUT/PATCH with at least one `in:"body"` field. */
const writeActions: {
  key: string;
  provider: string;
  action: IntegrationAction;
}[] = Object.entries(INTEGRATION_CATALOG).flatMap(([providerKey, provider]) =>
  provider.actions
    .filter(
      (a) =>
        a.write &&
        ["POST", "PUT", "PATCH"].includes(a.method) &&
        a.fields.some((f) => f.in === "body"),
    )
    .map((action) => ({
      key: `${providerKey}.${action.key}`,
      provider: providerKey,
      action,
    })),
);

const SHAPES: Shape[] = ["FULL", "REQUIRED", "MINIMAL"];

describe("every write action's body, built three ways", () => {
  it("covers the whole catalog, so a new provider can't slip past this file", () => {
    // Guard the guard: if the catalog failed to load, every `it.each` below would vacuously pass.
    expect(writeActions.length).toBeGreaterThan(60);
    expect(new Set(writeActions.map((w) => w.provider)).size).toBeGreaterThan(
      25,
    );
  });

  it.each(writeActions.map((w) => [w.key, w] as const))(
    "%s builds in all three shapes",
    (_name, { provider, action }) => {
      for (const shape of SHAPES) {
        const req = buildIntegrationRequest(
          provider,
          action.key,
          valuesFor(action, shape),
        );
        expect(req.method, `${shape}`).toBe(action.method);
        // A resolved path never keeps a placeholder — that was #866's failure, one layer up.
        expect(req.path.split("?")[0], `${shape}`).not.toMatch(/[{}]/);
      }
    },
  );

  /**
   * Scoped to NESTED envelopes — a path with a dot in it — and that is the same boundary
   * `buildIntegrationRequest`'s second pass draws, for the same reason. A TOP-LEVEL envelope made
   * only of consts is a legitimate request: `PUT /incidents/{id}` with
   * `{incident: {type: "incident_reference", status: "acknowledged"}}` is exactly how PagerDuty
   * acknowledges, and there is nothing else to send. One level down it inverts — `incident.body`
   * exists only to carry `details`, so `{type: "incident_body"}` alone is an announcement of a
   * payload that isn't there.
   */
  it.each(writeActions.map((w) => [w.key, w] as const))(
    "%s never conjures a NESTED envelope out of `const` fields alone",
    (name, { provider, action }) => {
      const constPaths = new Set(
        action.fields
          .filter((f) => f.in === "body" && f.const !== undefined)
          .map(bodyPathOf),
      );
      if (constPaths.size === 0) return; // nothing to conjure
      for (const shape of SHAPES) {
        const req = buildIntegrationRequest(
          provider,
          action.key,
          valuesFor(action, shape),
        );
        if (!req.body) continue;
        for (const envelope of objectPaths(req.body)) {
          if (!envelope.includes(".")) continue; // top-level: see the docblock above
          const leaves = leafPaths(req.body).filter(
            (l) => l === envelope || l.startsWith(`${envelope}.`),
          );
          const carriesRealData = leaves.some((l) => !constPaths.has(l));
          expect(
            carriesRealData,
            `${name} [${shape}]: "${envelope}" is made only of const discriminators ` +
              `(${leaves.join(", ")}). A nested envelope with no payload is a request the ` +
              "provider rejects — see buildIntegrationRequest's second pass.",
          ).toBe(true);
        }
      }
    },
  );

  /**
   * The known-good case, pinned by name rather than derived: with no `details`, PagerDuty's
   * incident must carry no `body` at all — and with details, it must carry both.
   */
  it("PagerDuty sends incident.body only when there are details", () => {
    const withoutDetails = buildIntegrationRequest(
      "pagerduty",
      "create_incident",
      {
        title: "Disk full",
        serviceId: "PW7YESS",
      },
    );
    expect(
      (withoutDetails.body as Record<string, any>).incident.body,
    ).toBeUndefined();
    // The envelope's OWN discriminator is not conditional — it sits at the top of the payload.
    expect((withoutDetails.body as Record<string, any>).incident.type).toBe(
      "incident",
    );

    const withDetails = buildIntegrationRequest(
      "pagerduty",
      "create_incident",
      {
        title: "Disk full",
        serviceId: "PW7YESS",
        details: "/dev/sda1 at 100%",
      },
    );
    expect((withDetails.body as Record<string, any>).incident.body).toEqual({
      details: "/dev/sda1 at 100%",
      type: "incident_body",
    });
  });
});

describe("form-encoded actions stay flat (#707)", () => {
  const formActions = writeActions.filter(
    (w) => w.action.bodyEncoding === "form",
  );

  it("finds the form-encoded actions to check", () => {
    expect(formActions.length).toBeGreaterThan(0);
  });

  /**
   * A CATALOG-time invariant, not a runtime one. `formEncodeBody` throws on a nested value, and
   * `buildIntegrationRequest` throws earlier so the activity can classify it as a non-retryable
   * config fault — but both of those fire at RUN time, in front of an author who can do nothing
   * about it. A `bodyPath` with a dot, or a `type: "json"` field, on a form-encoded action is an
   * action that can NEVER succeed, and that is knowable here.
   */
  it.each(formActions.map((w) => [w.key, w] as const))(
    "%s declares no nested field",
    (name, { action }) => {
      for (const field of action.fields.filter((f) => f.in === "body")) {
        expect(
          bodyPathOf(field),
          `${name}: form-encoded, but field "${field.key}" writes a nested bodyPath`,
        ).not.toContain(".");
        expect(
          field.type,
          `${name}: form-encoded, but field "${field.key}" is type "json" — a form body has no ` +
            "nesting, so this could only ever be rejected",
        ).not.toBe("json");
      }
    },
  );

  /**
   * #813's finding in the #707 machinery: the build-time refusal skipped ARRAY ELEMENTS
   * (`if (Array.isArray(value)) continue`), so `{name: ["a", {x: 1}]}` reached the planner, which
   * throws AFTER auth resolution — where the activity's catch maps it to INTEGRATION_TRANSIENT,
   * sanitizes the message away, and (for a read) retries it three times. Reachable from any
   * `type: "string[]"` field bound to run data that yields objects.
   */
  it("refuses an object INSIDE a list, at build time", () => {
    expect(() =>
      buildIntegrationRequest("stripe", "create_customer", {
        name: ["ok", { nested: "value-should-not-appear" }],
      }),
    ).toThrow(/nested value for 'name'/);
    expect(() =>
      buildIntegrationRequest("stripe", "create_customer", {
        name: ["ok", { nested: "value-should-not-appear" }],
      }),
    ).not.toThrow(/value-should-not-appear/);
  });

  it("still allows a list of scalars", () => {
    const req = buildIntegrationRequest("twilio", "send_sms", {
      accountSid: "AC1",
      To: "+15550001111",
      From: "+15552223333",
      Body: "hi",
    });
    expect(req.body).toEqual({
      To: "+15550001111",
      From: "+15552223333",
      Body: "hi",
    });
  });
});
