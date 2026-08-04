/**
 * Guard: an `atlassian` connection must start consent on the ATLASSIAN route, never the generic one.
 *
 * Two OAuth flows exist and they are not interchangeable:
 *  - `POST …/connections/:id/oauth/start` — `.well-known` discovery + dynamic client registration
 *    against the connection's OWN serverUrl. Right for an arbitrary MCP server.
 *  - `POST …/connections/:id/atlassian/oauth/start` — our fixed platform app: fixed endpoints, a
 *    required `audience`, a cloudId resolved after the exchange.
 *
 * Atlassian's serverUrl is a `*.atlassian.net` site that publishes no OAuth metadata, so the
 * generic route cannot work for it. Both connections carry `authMode: "oauth"`, which is precisely
 * why the bug happened: dispatching on authMode looks correct and routes Atlassian into discovery.
 *
 * FOUND IN PRODUCTION, from a request URL:
 *   POST /api/tenants/t-demo/connections/3040e824-…/oauth/start
 * on a connection that needed `/atlassian/oauth/start`.
 *
 * apps/web's vitest env is `node` — no jsdom, so no click-and-assert (see
 * settings-touch-targets.spec.ts for the same constraint). This pins the SOURCE shape the
 * behaviour depends on.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(__dirname, "../src");
const appsTab = readFileSync(
  path.join(SRC, "screens/app/integrations/AppsTab.tsx"),
  "utf8",
);
const forms = readFileSync(
  path.join(SRC, "screens/app/integrations/connection-forms.tsx"),
  "utf8",
);

/**
 * The body of a `function <name>(` … `)`, by BRACE BALANCE.
 *
 * Not `indexOf(start)`…`indexOf(end)`: that answers -1 on a moved anchor and `slice(from, -1)`
 * silently returns the rest of the file, so the assertion passes against unrelated source. That
 * exact false-pass was found in workspace-switcher-width.spec.ts (#1071).
 */
function functionBody(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  expect(
    start,
    `${name}() not found — did it move or get renamed?`,
  ).toBeGreaterThan(-1);
  const open = source.indexOf("{", source.indexOf(")", start));
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0)
      return source.slice(open, i + 1);
  }
  throw new Error(`unbalanced braces in ${name}()`);
}

describe("Atlassian connections start consent on the Atlassian route (#241)", () => {
  it("Re-authorize dispatches on the connection TYPE, not just authMode", () => {
    const body = functionBody(appsTab, "reconnect");
    expect(body).toMatch(/type\s*===\s*"atlassian"/);
    expect(body).toMatch(/startAtlassianConsent/);
    // The generic route must still be reachable — this is a SPLIT, not a replacement. An MCP
    // server connection re-authorizing through the Atlassian flow would be the mirror-image bug.
    expect(body).toMatch(/startOauthConsent/);
  });

  it("Re-authorize does not call the generic route unconditionally", () => {
    const body = functionBody(appsTab, "reconnect");
    // The regression shape: `api.startOauthConsent(...)` as the only call, with no type branch.
    const genericOnly =
      /startOauthConsent/.test(body) && !/startAtlassianConsent/.test(body);
    expect(
      genericOnly,
      "reconnect() sends every oauth connection down discovery",
    ).toBe(false);
  });

  it("the connect form's oauth branch makes the same split", () => {
    // Creating an `atlassian` + `oauth` connection through the generic form must not start the
    // discovery flow either — same defect, second site, and the one a NEW connection hits.
    expect(forms).toMatch(
      /type\s*===\s*"atlassian"[\s\S]{0,120}startAtlassianConsent/,
    );
  });
});
