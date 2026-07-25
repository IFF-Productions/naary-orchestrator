import "reflect-metadata";
import type { AddressInfo } from "node:net";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SsoController } from "../src/sso/sso.controller";
import { SsoLoginError, SsoService } from "../src/sso/sso.service";

/**
 * A REAL HTTP round trip against a minimal Nest app (Express adapter) — not a direct method
 * call. That is deliberate: an IdP POSTs `SAMLResponse` as **form-urlencoded**, so "does the
 * app actually parse that body?" is a property of the HTTP stack, not of the controller, and
 * only a real request proves it.
 *
 * No IdP is involved: `SsoService` is a double here (the assertion path is covered by
 * saml.spec.ts / sso.service.spec.ts).
 */

const consumeAssertion = vi.fn();
const ssoUrlForSlug = vi.fn();
/** Whether the (doubled) SsoService reports SAML as usable — see the metadata 503 cases. */
let ssoEnabled = true;

let app: INestApplication;
let base: string;

beforeAll(async () => {
  process.env.APP_BASE_URL = "https://app.naary.test";
  process.env.SSO_SP_ENTITY_ID = "https://api.naary.test/sso/metadata";
  process.env.SSO_ACS_URL = "https://api.naary.test/sso/saml/acs";
  const moduleRef = await Test.createTestingModule({
    controllers: [SsoController],
    providers: [
      {
        provide: SsoService,
        useValue: {
          consumeAssertion,
          ssoUrlForSlug,
          get enabled() {
            return ssoEnabled;
          },
        },
      },
    ],
  }).compile();
  app = moduleRef.createNestApplication();
  await app.init();
  await app.listen(0);
  const server = app.getHttpServer();
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await app?.close();
});

describe("SsoController — SP metadata", () => {
  it("serves SP metadata XML an IdP admin can import", async () => {
    const res = await fetch(`${base}/sso/metadata`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("xml");
    const xml = await res.text();
    expect(xml).toContain('entityID="https://api.naary.test/sso/metadata"');
    expect(xml).toContain('Location="https://api.naary.test/sso/saml/acs"');
  });

  it("says 503 when logins are disabled even though the SP config is present", async () => {
    // A short/absent SSO_SESSION_SECRET disables logins; serving metadata anyway would let an
    // IdP admin configure against an instance that refuses every login.
    ssoEnabled = false;
    try {
      const res = await fetch(`${base}/sso/metadata`);
      expect(res.status).toBe(503);
    } finally {
      ssoEnabled = true;
    }
  });

  it("says 503 (not a broken document) when SAML is unconfigured", async () => {
    const saved = process.env.SSO_ACS_URL;
    delete process.env.SSO_ACS_URL;
    try {
      const res = await fetch(`${base}/sso/metadata`);
      expect(res.status).toBe(503);
      expect(await res.text()).toMatch(/not configured/i);
    } finally {
      process.env.SSO_ACS_URL = saved;
    }
  });
});

describe("SsoController — ACS (form-urlencoded POST, as an IdP sends it)", () => {
  it("parses the form body and redirects with the session in the FRAGMENT", async () => {
    consumeAssertion.mockResolvedValue({
      token: "nrys_the.session.jwt",
      tenantId: "ws-a",
      outcome: "provisioned",
    });
    const res = await fetch(`${base}/sso/saml/acs`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        SAMLResponse: "PHNhbWw+",
        RelayState: "https://evil.example/steal",
      }).toString(),
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    // The body really was parsed (the service saw the field, not undefined).
    expect(consumeAssertion).toHaveBeenCalledWith("PHNhbWw+");
    // Fragment, not query: it never reaches a server log.
    expect(location).toContain("#sso_token=nrys_the.session.jwt");
    expect(location).toContain("workspace=ws-a");
    expect(location.split("#")[0]).toBe("https://app.naary.test/app");
    expect(location).not.toContain("?sso_token");
    // RelayState is IGNORED — echoing a client-supplied target is an open redirect.
    expect(location).not.toContain("evil.example");
  });

  it("turns any rejection into a coarse 302 with a code — never a 500, never detail", async () => {
    consumeAssertion.mockRejectedValue(
      new SsoLoginError(
        "email_domain_not_allowed",
        "domain 'tenant-b.com' not allowed for connection conn-a",
      ),
    );
    const res = await fetch(`${base}/sso/saml/acs`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ SAMLResponse: "PHNhbWw+" }).toString(),
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toBe(
      "https://app.naary.test/app?sso_error=email_domain_not_allowed",
    );
    // The detail (which names the tenant's domain + connection) stays server-side.
    expect(location).not.toContain("tenant-b.com");
    expect(location).not.toContain("conn-a");
  });

  it("an unexpected error is still a coarse redirect (no stack, no 500)", async () => {
    consumeAssertion.mockRejectedValue(new Error("boom: postgres is down"));
    const res = await fetch(`${base}/sso/saml/acs`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ SAMLResponse: "PHNhbWw+" }).toString(),
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "https://app.naary.test/app?sso_error=sso_failed",
    );
  });

  it("a missing SAMLResponse is handled by the service, not a framework 400", async () => {
    consumeAssertion.mockRejectedValue(new SsoLoginError("malformed"));
    const res = await fetch(`${base}/sso/saml/acs`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "",
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(consumeAssertion).toHaveBeenCalledWith("");
  });
});

describe("SsoController — IdP-initiated entry", () => {
  it("redirects to the IdP for a known slug", async () => {
    ssoUrlForSlug.mockResolvedValue("https://idp.example.com/sso/start");
    const res = await fetch(`${base}/sso/acme`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "https://idp.example.com/sso/start",
    );
  });

  it("redirects to the SPA with a code for an unknown slug", async () => {
    ssoUrlForSlug.mockRejectedValue(new SsoLoginError("unknown_idp"));
    const res = await fetch(`${base}/sso/nope`, { redirect: "manual" });
    expect(res.headers.get("location")).toBe(
      "https://app.naary.test/app?sso_error=unknown_idp",
    );
  });

  it("route ordering: /sso/metadata is NOT swallowed by the :slug route", async () => {
    ssoUrlForSlug.mockResolvedValue(
      "https://idp.example.com/should-not-be-used",
    );
    const res = await fetch(`${base}/sso/metadata`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("EntityDescriptor");
  });
});
