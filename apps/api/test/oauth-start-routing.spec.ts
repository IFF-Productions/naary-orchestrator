/**
 * The discovery-based OAuth start refuses connections it cannot serve, with a reason.
 *
 * Reported from production as `{"statusCode":500}` on
 * `POST /tenants/:id/connections/:cid/oauth/start` for an ATLASSIAN connection: the SPA of the day
 * sent every `oauth` connection down this route, and `startConsent` went on to fetch
 * `.well-known/oauth-authorization-server` from a *.atlassian.net site that publishes no such
 * document. The browser got a 500 with nothing in it.
 *
 * #1085 fixed the caller. This is the other half — the endpoint's own answer when it is asked for
 * something it structurally cannot do. A wrong-typed connection is a client mistake (400), and the
 * message names the route that WOULD work, because the person reading it is already stuck.
 */
import "reflect-metadata";
import { beforeEach, describe, expect, it, vi } from "vitest";

// `vi.hoisted`, because vi.mock's factory is lifted above the imports and a plain const declared
// here would not exist yet when it runs.
const mocks = vi.hoisted(() => ({
  startConsent: vi.fn(async () => ({ authorizeUrl: "https://auth/x" })),
}));
vi.mock("@naary/connections", () => ({
  ConnectionService: class {},
  startConsent: mocks.startConsent,
  completeConsent: vi.fn(),
}));
const { startConsent } = mocks;
vi.mock("../src/config", () => ({
  oauthRedirectUri: () => "https://app.example/api/oauth/callback",
}));

import { OAuthController } from "../src/connections/oauth.controller";

/** A ConnectionService stub returning one row. */
function controllerFor(conn: Record<string, unknown> | null) {
  return new OAuthController({
    getById: async () => conn,
  } as never);
}

/** Await a call that must REJECT, and hand back the HTTP error it rejected with. Written out
 *  rather than inlined as `.catch(e => e)`, which types the result as a union with the success
 *  shape and then cannot read `getStatus` off it. */
async function failure(
  p: Promise<unknown>,
): Promise<{ getStatus(): number; message: string }> {
  let caught: unknown;
  try {
    await p;
  } catch (e) {
    caught = e;
  }
  if (!caught) throw new Error("expected the call to fail, but it resolved");
  return caught as { getStatus(): number; message: string };
}

beforeEach(() => startConsent.mockClear());

describe("POST /connections/:id/oauth/start", () => {
  it("refuses an ATLASSIAN connection with the route that actually works", async () => {
    const ctl = controllerFor({
      type: "atlassian",
      environmentId: "e1",
      serverUrl: "https://acme.atlassian.net",
    });
    const err = await failure(ctl.start("t1", "c1"));
    expect(err.getStatus()).toBe(400);
    // Naming the other route is the point: a 400 reading "bad request" would leave the caller
    // exactly as stuck as the 500 did.
    expect(String(err.message)).toContain("/connections/atlassian/oauth/start");
    // And it never reached discovery — that fetch is what produced the 500.
    expect(startConsent).not.toHaveBeenCalled();
  });

  it("refuses a connection with no server URL, rather than discovering against nothing", async () => {
    const ctl = controllerFor({
      type: "custom",
      environmentId: "e1",
      serverUrl: "  ",
    });
    const err = await failure(ctl.start("t1", "c1"));
    expect(err.getStatus()).toBe(400);
    expect(startConsent).not.toHaveBeenCalled();
  });

  it("still starts consent for an MCP-style connection — the case this route is FOR", async () => {
    const ctl = controllerFor({
      type: "custom",
      environmentId: "e1",
      serverUrl: "https://mcp.example.com",
    });
    await expect(ctl.start("t1", "c1")).resolves.toEqual({
      authorizeUrl: "https://auth/x",
    });
    expect(startConsent).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "t1",
        environmentId: "e1",
        connectionId: "c1",
        serverUrl: "https://mcp.example.com",
      }),
    );
  });

  it("trims the server URL rather than passing the row's whitespace through", async () => {
    // `startConsent` stores this verbatim as the state's `resource` AND puts it in the authorize
    // URL, so a stray space on an existing row would pass the emptiness guard and then break
    // consent somewhere that names neither the value nor this endpoint.
    const ctl = controllerFor({
      type: "custom",
      environmentId: "e1",
      serverUrl: "  https://mcp.example.com  ",
    });
    await ctl.start("t1", "c1");
    expect(startConsent).toHaveBeenCalledWith(
      expect.objectContaining({ serverUrl: "https://mcp.example.com" }),
    );
  });

  it("a missing connection is still a 404, not a 400", async () => {
    const err = await failure(controllerFor(null).start("t1", "nope"));
    expect(err.getStatus()).toBe(404);
  });
});
