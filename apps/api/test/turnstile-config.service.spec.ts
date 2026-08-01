import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the Prisma accessor before importing the service.
const turnstileConfig = {
  findUnique: vi.fn(),
  upsert: vi.fn(),
  deleteMany: vi.fn(),
  count: vi.fn(),
};
vi.mock("@naary/db", () => ({ getPrisma: () => ({ turnstileConfig }) }));

import type { SecretStore } from "@naary/secrets";
import type { AppCheckVerifier } from "../src/turnstile/app-check-verifier";
import {
  __turnstileDeps,
  TurnstileConfigService,
  botTokenFrom,
} from "../src/turnstile/turnstile-config.service";

function makeService(appCheck?: {
  enabled: boolean;
  verify?: (t: string) => Promise<"ok" | "denied" | "unavailable">;
}) {
  const secrets = {
    get: vi.fn().mockResolvedValue(null),
    put: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
  };
  // Default: NO App Check verifier available (`null` config = explicitly disabled), so these tests
  // never depend on whether a Firebase service account happens to be in the ambient env.
  const gate = appCheck ?? { enabled: false };
  const service = new TurnstileConfigService(
    secrets as unknown as SecretStore,
    {
      enabled: gate.enabled,
      verify: gate.verify ?? (async () => "ok" as const),
    } as unknown as AppCheckVerifier,
  );
  return { service, secrets };
}

const T = "t-1";
const E = "e-1";

beforeEach(() => {
  turnstileConfig.findUnique.mockReset();
  turnstileConfig.upsert.mockReset().mockResolvedValue(undefined);
  turnstileConfig.deleteMany.mockReset().mockResolvedValue({ count: 1 });
  turnstileConfig.count.mockReset().mockResolvedValue(0);
});

/**
 * THE BOOT DIAGNOSTIC MUST NOT GO SILENT ABOUT ITSELF (#830).
 *
 * This check exists to shout when environments rely on an App Check gate this deployment cannot
 * verify — i.e. when public forms are ungated right now. It swallowed its own failure, so the boot
 * log had two indistinguishable meanings: "checked, all enforceable" and "the check died". For a
 * diagnostic whose whole subject is a security gate, clean-looking silence is the wrong default.
 */
describe("bot-gate boot diagnostic", () => {
  it("warns when App Check gates exist but cannot be enforced", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { service } = makeService({ enabled: false });
    turnstileConfig.count.mockResolvedValue(2);

    await service.onApplicationBootstrap();

    expect(String(warn.mock.calls[0]?.[0])).toContain("CANNOT be enforced");
    warn.mockRestore();
  });

  it("says so when the check itself could not run (never silently)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { service } = makeService({ enabled: false });
    turnstileConfig.count.mockRejectedValue(new Error("db unreachable"));

    // Unchanged: a DB hiccup here must never block startup.
    await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();

    const line = warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(line).toContain("could not check for unenforceable App Check gates");
    expect(line).toContain("db unreachable");
    warn.mockRestore();
  });

  it("stays quiet when this deployment CAN verify App Check", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { service } = makeService({ enabled: true });

    await service.onApplicationBootstrap();

    expect(warn).not.toHaveBeenCalled();
    expect(turnstileConfig.count).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("TurnstileConfigService", () => {
  it("get returns null when no config exists", async () => {
    const { service } = makeService();
    turnstileConfig.findUnique.mockResolvedValue(null);
    expect(await service.get(T, E)).toBeNull();
  });

  it("get returns the view with hasSecret, but NEVER the secret value", async () => {
    const { service, secrets } = makeService();
    turnstileConfig.findUnique.mockResolvedValue({
      siteKey: "site",
      enabled: true,
      allowedHostnames: ["example.com"],
    });
    secrets.get.mockResolvedValue("the-secret"); // a secret IS stored
    const view = await service.get(T, E);
    expect(view).toEqual({
      siteKey: "site",
      enabled: true,
      hasSecret: true,
      // A row written before #782 has no provider ⇒ reads as turnstile, its existing behaviour.
      provider: "turnstile",
      // No App Check verifier injected here, so the platform can't offer it.
      appCheckAvailable: false,
      allowedHostnames: ["example.com"],
    });
    // the plaintext secret must not appear anywhere in the returned view
    expect(JSON.stringify(view)).not.toContain("the-secret");
  });

  it("hasSecret is false when no secret is stored", async () => {
    const { service, secrets } = makeService();
    turnstileConfig.findUnique.mockResolvedValue({
      siteKey: "site",
      enabled: false,
    });
    secrets.get.mockResolvedValue(null);
    expect((await service.get(T, E))?.hasSecret).toBe(false);
  });

  it("save upserts site key + enabled and stores the secret when provided", async () => {
    const { service, secrets } = makeService();
    turnstileConfig.findUnique.mockResolvedValue({
      siteKey: "site",
      enabled: true,
    });
    secrets.get.mockResolvedValue("x");
    await service.save(T, E, {
      siteKey: " site ",
      secretKey: " sk ",
      enabled: true,
    });
    expect(turnstileConfig.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ siteKey: "site", enabled: true }),
        update: expect.objectContaining({ siteKey: "site", enabled: true }),
      }),
    );
    // secret stored under the reserved, listing-excluded key, trimmed
    expect(secrets.put).toHaveBeenCalledWith(T, E, "turnstile:secret", "sk");
  });

  it("save does NOT touch the secret when secretKey is omitted (write-only keep)", async () => {
    const { service, secrets } = makeService();
    turnstileConfig.findUnique.mockResolvedValue({
      siteKey: "site",
      enabled: false,
    });
    secrets.get.mockResolvedValue("x");
    await service.save(T, E, { siteKey: "site", enabled: false });
    expect(secrets.put).not.toHaveBeenCalled();
  });

  it("save rejects a missing site key when ENABLING the gate", async () => {
    const { service } = makeService();
    await expect(
      service.save(T, E, { siteKey: "  ", enabled: true }),
    ).rejects.toThrow();
    expect(turnstileConfig.upsert).not.toHaveBeenCalled();
  });

  // ── #617: the row also carries the SHARED embed-domain allowlist ───────────────────────
  it("save accepts a DOMAINS-ONLY config (gate off, no keys)", async () => {
    const { service, secrets } = makeService();
    turnstileConfig.findUnique.mockResolvedValue(null); // no row yet
    secrets.get.mockResolvedValue(null);
    await service.save(T, E, {
      enabled: false,
      allowedHostnames: ["example.com"],
    });
    expect(turnstileConfig.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          siteKey: "",
          enabled: false,
          allowedHostnames: ["example.com"],
        }),
      }),
    );
  });

  it("save keeps a STORED site key when the caller sends none (no silent wipe)", async () => {
    const { service, secrets } = makeService();
    turnstileConfig.findUnique.mockResolvedValue({
      siteKey: "stored-site",
      enabled: true,
    });
    secrets.get.mockResolvedValue("x");
    await service.save(T, E, { enabled: true, allowedHostnames: ["a.com"] });
    expect(turnstileConfig.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ siteKey: "stored-site" }),
      }),
    );
  });

  it("normalizes allowed domains to bare hostnames (origins/ports/paths/case, de-duped)", async () => {
    const { service, secrets } = makeService();
    turnstileConfig.findUnique.mockResolvedValue({
      siteKey: "site",
      enabled: false,
    });
    secrets.get.mockResolvedValue(null);
    await service.save(T, E, {
      enabled: false,
      allowedHostnames: [
        "https://Example.com/forms/x",
        "example.com", // dupe after normalization
        "shop.example.com:3000",
        "  ",
        "not a hostname",
        42 as unknown as string,
      ],
    });
    expect(turnstileConfig.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          allowedHostnames: ["example.com", "shop.example.com"],
        }),
      }),
    );
  });

  it("remove deletes the row AND the stored secret", async () => {
    const { service, secrets } = makeService();
    await service.remove(T, E);
    expect(turnstileConfig.deleteMany).toHaveBeenCalledWith({
      where: { tenantId: T, environmentId: E },
    });
    expect(secrets.remove).toHaveBeenCalledWith(T, E, "turnstile:secret");
  });
});

describe("TurnstileConfigService.publicSiteKey", () => {
  it("returns the site key only when enabled AND a secret is stored", async () => {
    const { service, secrets } = makeService();
    turnstileConfig.findUnique.mockResolvedValue({
      siteKey: "sk",
      enabled: true,
    });
    secrets.get.mockResolvedValue("secret");
    expect(await service.publicSiteKey(T, E)).toBe("sk");
  });

  it("returns null when disabled or unconfigured or secret-less", async () => {
    const { service, secrets } = makeService();
    // disabled
    turnstileConfig.findUnique.mockResolvedValue({
      siteKey: "sk",
      enabled: false,
    });
    secrets.get.mockResolvedValue("secret");
    expect(await service.publicSiteKey(T, E)).toBeNull();
    // enabled but no secret
    turnstileConfig.findUnique.mockResolvedValue({
      siteKey: "sk",
      enabled: true,
    });
    secrets.get.mockResolvedValue(null);
    expect(await service.publicSiteKey(T, E)).toBeNull();
    // no row
    turnstileConfig.findUnique.mockResolvedValue(null);
    expect(await service.publicSiteKey(T, E)).toBeNull();
  });
});

describe("TurnstileConfigService.verify", () => {
  const realFetch = __turnstileDeps.fetch;
  afterEach(() => {
    __turnstileDeps.fetch = realFetch;
  });

  function enforced(
    secrets: { get: ReturnType<typeof vi.fn> },
    allowedHostnames: string[] = [],
  ) {
    turnstileConfig.findUnique.mockResolvedValue({
      siteKey: "sk",
      enabled: true,
      allowedHostnames,
    });
    secrets.get.mockResolvedValue("the-secret");
  }

  function siteverifyReturns(json: Record<string, unknown>) {
    __turnstileDeps.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => json,
    }) as never;
  }

  it("ALLOWS (no siteverify) when the gate isn't enforced", async () => {
    const { service, secrets } = makeService();
    turnstileConfig.findUnique.mockResolvedValue({
      siteKey: "sk",
      enabled: false,
    });
    secrets.get.mockResolvedValue("x");
    const fetchSpy = vi.fn();
    __turnstileDeps.fetch = fetchSpy as never;
    expect(await service.verify(T, E, "tok")).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("ALLOWS when enabled but no secret (can't enforce)", async () => {
    const { service, secrets } = makeService();
    turnstileConfig.findUnique.mockResolvedValue({
      siteKey: "sk",
      enabled: true,
    });
    secrets.get.mockResolvedValue(null);
    expect(await service.verify(T, E, "tok")).toBe(true);
  });

  it("DENIES when enforced and no token", async () => {
    const { service, secrets } = makeService();
    enforced(secrets);
    expect(await service.verify(T, E, undefined)).toBe(false);
  });

  it("verifies with Cloudflare and DENIES on success:false", async () => {
    const { service, secrets } = makeService();
    enforced(secrets);
    __turnstileDeps.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: false }),
    }) as never;
    expect(await service.verify(T, E, "bad")).toBe(false);
  });

  it("ALLOWS on success:true", async () => {
    const { service, secrets } = makeService();
    enforced(secrets);
    __turnstileDeps.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true }),
    }) as never;
    expect(await service.verify(T, E, "good")).toBe(true);
  });

  it("FAILS OPEN on a network error (Cloudflare outage must not brick the form)", async () => {
    const { service, secrets } = makeService();
    enforced(secrets);
    __turnstileDeps.fetch = vi
      .fn()
      .mockRejectedValue(new Error("network")) as never;
    expect(await service.verify(T, E, "tok")).toBe(true);
  });

  it("FAILS OPEN on a 5xx from Cloudflare", async () => {
    const { service, secrets } = makeService();
    enforced(secrets);
    __turnstileDeps.fetch = vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({}),
    }) as never;
    expect(await service.verify(T, E, "tok")).toBe(true);
  });

  // #615 — allowed-hostnames check (server-side "allowed domains", also kills token-replay).
  it("ALLOWS a solved hostname that IS on the allowlist", async () => {
    const { service, secrets } = makeService();
    enforced(secrets, ["example.com"]);
    siteverifyReturns({ success: true, hostname: "example.com" });
    expect(await service.verify(T, E, "good")).toBe(true);
  });

  it("DENIES a solved hostname NOT on the allowlist (replay from another site)", async () => {
    const { service, secrets } = makeService();
    enforced(secrets, ["example.com"]);
    siteverifyReturns({ success: true, hostname: "attacker.test" });
    expect(await service.verify(T, E, "lifted")).toBe(false);
  });

  it("DENIES when the allowlist is set but siteverify returns no hostname", async () => {
    const { service, secrets } = makeService();
    enforced(secrets, ["example.com"]);
    siteverifyReturns({ success: true });
    expect(await service.verify(T, E, "x")).toBe(false);
  });

  it("matches the allowlist case-insensitively", async () => {
    const { service, secrets } = makeService();
    enforced(secrets, ["example.com"]);
    siteverifyReturns({ success: true, hostname: "EXAMPLE.COM" });
    expect(await service.verify(T, E, "x")).toBe(true);
  });

  it("an EMPTY allowlist allows any solved hostname (no restriction)", async () => {
    const { service, secrets } = makeService();
    enforced(secrets, []);
    siteverifyReturns({ success: true, hostname: "anywhere.test" });
    expect(await service.verify(T, E, "x")).toBe(true);
  });
});

/**
 * #782 slice 1 — the SECOND provider (App Check). docs/design/TENANT-BOT-GATE-PROVIDERS.md.
 *
 * The through-line: App Check is the PLATFORM's gate, so the tenant supplies nothing, `allowedHostnames`
 * has no bot-check analogue, and everything hinges on whether this deployment can verify at all.
 */
describe("bot-gate provider: app_check", () => {
  const appCheckRow = (over: Record<string, unknown> = {}) => ({
    siteKey: "",
    enabled: true,
    provider: "app_check",
    allowedHostnames: [],
    ...over,
  });

  describe("save validation is provider-CONDITIONAL", () => {
    /** The regression the design called out: requiring a site key for app_check would 400 every enable. */
    it("enables app_check with NO tenant keys at all", async () => {
      const { service } = makeService({ enabled: true });
      turnstileConfig.findUnique
        .mockResolvedValueOnce(null) // pre-read in save()
        .mockResolvedValueOnce(appCheckRow()); // the get() after upsert
      const view = await service.save(T, E, {
        provider: "app_check",
        enabled: true,
      });
      expect(view.provider).toBe("app_check");
      expect(turnstileConfig.upsert).toHaveBeenCalledOnce();
      expect(turnstileConfig.upsert.mock.calls[0][0].create).toMatchObject({
        provider: "app_check",
        enabled: true,
        siteKey: "",
      });
    });

    it("still requires a site key to enable TURNSTILE", async () => {
      const { service } = makeService();
      turnstileConfig.findUnique.mockResolvedValue(null);
      await expect(
        service.save(T, E, { provider: "turnstile", enabled: true }),
      ).rejects.toThrow(/site key/i);
    });

    /** Can't enable a gate we couldn't enforce — the page would gate a submit we'd wave through. */
    it("refuses app_check when the platform can't verify it", async () => {
      const { service } = makeService({ enabled: false });
      turnstileConfig.findUnique.mockResolvedValue(null);
      await expect(
        service.save(T, E, { provider: "app_check", enabled: true }),
      ).rejects.toThrow(/isn't available on this instance/i);
    });

    /** A DISABLED app_check row is fine even unavailable: #617 rows exist just to hold embed domains. */
    it("allows saving a disabled app_check row on an instance without App Check", async () => {
      const { service } = makeService({ enabled: false });
      turnstileConfig.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(appCheckRow({ enabled: false }));
      await expect(
        service.save(T, E, { provider: "app_check", enabled: false }),
      ).resolves.toMatchObject({ provider: "app_check", enabled: false });
    });

    it("refuses an unknown provider instead of coercing it", async () => {
      const { service } = makeService({ enabled: true });
      turnstileConfig.findUnique.mockResolvedValue(null);
      await expect(
        service.save(T, E, { provider: "recaptcha", enabled: true }),
      ).rejects.toThrow(/Unknown bot-protection provider/i);
    });

    it("keeps the stored provider when the caller omits it", async () => {
      const { service } = makeService({ enabled: true });
      turnstileConfig.findUnique
        .mockResolvedValueOnce(appCheckRow()) // existing row is app_check
        .mockResolvedValueOnce(appCheckRow({ allowedHostnames: ["a.test"] }));
      await service.save(T, E, { allowedHostnames: ["a.test"] });
      // No site key was supplied and none is needed — the provider survived a domains-only edit.
      expect(turnstileConfig.upsert.mock.calls[0][0].update).toMatchObject({
        provider: "app_check",
      });
    });
  });

  describe("publicGate", () => {
    it("advertises app_check without a site key", async () => {
      const { service } = makeService({ enabled: true });
      turnstileConfig.findUnique.mockResolvedValue(appCheckRow());
      expect(await service.publicGate(T, E)).toEqual({ provider: "app_check" });
    });

    /** Same "only advertise what we can verify" rule Turnstile has for a missing secret. */
    it("advertises NOTHING when app_check is unverifiable here", async () => {
      const { service } = makeService({ enabled: false });
      turnstileConfig.findUnique.mockResolvedValue(appCheckRow());
      expect(await service.publicGate(T, E)).toBeNull();
    });

    it("returns the site key for turnstile, and publicSiteKey still works", async () => {
      const { service, secrets } = makeService();
      turnstileConfig.findUnique.mockResolvedValue({
        siteKey: "site",
        enabled: true,
        provider: "turnstile",
        allowedHostnames: [],
      });
      secrets.get.mockResolvedValue("sec");
      expect(await service.publicGate(T, E)).toEqual({
        provider: "turnstile",
        siteKey: "site",
      });
      expect(await service.publicSiteKey(T, E)).toBe("site");
    });

    /** The legacy accessor must not hand an App Check gate's absence of a key back as a key. */
    it("publicSiteKey is null for an app_check gate", async () => {
      const { service } = makeService({ enabled: true });
      turnstileConfig.findUnique.mockResolvedValue(appCheckRow());
      expect(await service.publicSiteKey(T, E)).toBeNull();
    });
  });

  describe("verify dispatch", () => {
    it("denies when no token is sent", async () => {
      const { service } = makeService({ enabled: true });
      turnstileConfig.findUnique.mockResolvedValue(appCheckRow());
      expect(await service.verify(T, E, undefined)).toBe(false);
    });

    it("allows on ok, denies on denied, ALLOWS on unavailable (fail-open)", async () => {
      for (const [verdict, expected] of [
        ["ok", true],
        ["denied", false],
        ["unavailable", true],
      ] as const) {
        const { service } = makeService({
          enabled: true,
          verify: async () => verdict,
        });
        turnstileConfig.findUnique.mockResolvedValue(appCheckRow());
        expect(await service.verify(T, E, "tok")).toBe(expected);
      }
    });

    /** Never calls Cloudflare for an app_check row — that would be the wrong provider entirely. */
    it("does not touch siteverify", async () => {
      const { service } = makeService({ enabled: true });
      turnstileConfig.findUnique.mockResolvedValue(appCheckRow());
      const fetchSpy = vi.fn();
      const prev = __turnstileDeps.fetch;
      __turnstileDeps.fetch = fetchSpy as unknown as typeof prev;
      try {
        await service.verify(T, E, "tok");
      } finally {
        __turnstileDeps.fetch = prev;
      }
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    /**
     * `allowedHostnames` is NOT enforced as a bot check for app_check — an App Check token carries no
     * solved hostname. This is the capability a tenant gives up by choosing it (design §1), so it is
     * pinned rather than left to be discovered as a surprise.
     */
    it("ignores allowedHostnames (no solved hostname exists to check)", async () => {
      const { service } = makeService({
        enabled: true,
        verify: async () => "ok",
      });
      turnstileConfig.findUnique.mockResolvedValue(
        appCheckRow({ allowedHostnames: ["only-this-host.test"] }),
      );
      expect(await service.verify(T, E, "tok")).toBe(true);
    });

    it("is not enforced at all while the row is disabled", async () => {
      const { service } = makeService({
        enabled: true,
        verify: async () => "denied",
      });
      turnstileConfig.findUnique.mockResolvedValue(
        appCheckRow({ enabled: false }),
      );
      expect(await service.verify(T, E, undefined)).toBe(true);
    });
  });
});

/** Both token field names reach the gate — `botToken` is the provider-neutral one, `turnstileToken`
 *  stays accepted so a CACHED embedded bundle on a tenant's site keeps working (design §4). */
describe("botTokenFrom", () => {
  it("prefers botToken, falls back to turnstileToken", () => {
    expect(botTokenFrom({ botToken: "a", turnstileToken: "b" })).toBe("a");
    expect(botTokenFrom({ turnstileToken: "b" })).toBe("b");
    expect(botTokenFrom({ botToken: "a" })).toBe("a");
  });

  it("yields undefined for anything that isn't a non-empty string", () => {
    for (const body of [
      {},
      null,
      undefined,
      { botToken: "" },
      { botToken: 42 },
      { botToken: {} },
      { turnstileToken: [] },
    ]) {
      expect(botTokenFrom(body as never)).toBeUndefined();
    }
  });

  /** An empty botToken must FALL THROUGH to the legacy field rather than mask it. */
  it("falls through an empty botToken to turnstileToken", () => {
    expect(botTokenFrom({ botToken: "", turnstileToken: "b" })).toBe("b");
  });
});
