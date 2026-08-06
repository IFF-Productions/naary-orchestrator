import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiClient, type FetchLike } from "../src/client";
import { readConfigFile, writeConfigFile } from "../src/config";
import type { AuthEnvironment, CommandContext } from "../src/context";
import { run } from "../src/run";

/**
 * `naary auth {login,status,logout}` as the user drives them — through the real router, with only
 * the outside world (clock, browser, network, config path) faked.
 */

let dir = "";
let file = "";
const opened: string[] = [];
const out: string[] = [];
const err: string[] = [];
let responses: Array<{ status?: number; body?: unknown }> = [];
let requests: Array<{ url: string; body: unknown }> = [];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "naary-auth-"));
  file = path.join(dir, "config.json");
  opened.length = 0;
  out.length = 0;
  err.length = 0;
  responses = [];
  requests = [];
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const fakeFetch: FetchLike = async (url, init) => {
  requests.push({ url, body: init?.body ? JSON.parse(init.body) : undefined });
  const reply = responses.shift() ?? { status: 200, body: {} };
  const status = reply.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () =>
      reply.body === undefined ? "" : JSON.stringify(reply.body),
  };
};

function ctx(over: Partial<AuthEnvironment> = {}): CommandContext {
  const auth: AuthEnvironment = {
    fetch: fakeFetch,
    sleep: async () => undefined,
    now: () => Date.parse("2026-08-05T12:00:00.000Z"),
    hostname: () => "test-box",
    openBrowser: (url) => {
      opened.push(url);
      return true;
    },
    configFile: file,
    ...over,
  };
  return {
    io: { out: (l) => out.push(l), err: (l) => err.push(l) },
    // The real resolver would read the developer's ~/.naary; commands only need apiUrl + the
    // token's provenance from here, and the session itself is read from `auth.configFile`.
    makeClient: (flags) => ({
      client: new ApiClient({ apiUrl: "https://naary.example" }, fakeFetch),
      config: {
        apiUrl: flags.apiUrl ?? "https://naary.example",
        token: flags.token ?? readConfigFile(file).token,
        tokenSource: flags.token ? "flag" : "file",
        env: flags.env,
      },
    }),
    auth,
  };
}

const START_OK = {
  status: 201,
  body: {
    deviceCode: "nryd_secret",
    userCode: "PQ4M-TWZ9",
    verificationUri: "/app/cli-login",
    expiresIn: 600,
    interval: 5,
  },
};
const AUTHORIZED = {
  status: 200,
  body: {
    status: "authorized",
    accessToken: "nry_access",
    accessTokenExpiresAt: "2026-08-06T00:00:00.000Z",
    refreshToken: "nryr_refresh",
    refreshTokenExpiresAt: "2026-11-03T00:00:00.000Z",
    tenantId: "tenant-A",
  },
};

describe("naary auth login (browser)", () => {
  it("shows the code, opens a browser, and stores the whole session", async () => {
    responses = [START_OK, { body: { status: "pending" } }, AUTHORIZED];
    expect(await run(["auth", "login"], ctx())).toBe(0);

    const text = out.join("\n");
    expect(text).toContain("PQ4M-TWZ9");
    expect(text).toContain("https://naary.example/app/cli-login");
    // The one thing a member cannot discover from the CLI (the 403 happens in the browser, and the
    // handshake just stays pending until it expires) — so it is said up front.
    expect(text).toContain("owner or admin");
    expect(opened).toEqual(["https://naary.example/app/cli-login"]);

    expect(readConfigFile(file)).toMatchObject({
      token: "nry_access",
      refreshToken: "nryr_refresh",
      tokenExpiresAt: "2026-08-06T00:00:00.000Z",
      refreshTokenExpiresAt: "2026-11-03T00:00:00.000Z",
      tenantId: "tenant-A",
    });
    // The device code is the CLI's alone: it is presented to /exchange and never written down.
    expect(fs.readFileSync(file, "utf8")).not.toContain("nryd_");
  });

  it("stores the session 0600 — a 90-day refresh token must not be world-readable", async () => {
    responses = [START_OK, AUTHORIZED];
    await run(["auth", "login"], ctx());
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    // No temp file left behind by the atomic write.
    expect(fs.readdirSync(dir)).toEqual(["config.json"]);
  });

  it("--no-browser prints the URL and launches nothing (the SSH case)", async () => {
    responses = [START_OK, AUTHORIZED];
    expect(await run(["auth", "login", "--no-browser"], ctx())).toBe(0);
    expect(opened).toEqual([]);
    expect(out.join("\n")).toContain("https://naary.example/app/cli-login");
  });

  it("reports a denial as a refusal, exits 1, and stores nothing", async () => {
    responses = [START_OK, { body: { status: "denied" } }];
    expect(await run(["auth", "login"], ctx())).toBe(1);
    expect(err.join("\n")).toContain("refused");
    expect(readConfigFile(file).token).toBeUndefined();
  });

  it("keeps --api-url/--env alongside the session", async () => {
    responses = [START_OK, AUTHORIZED];
    await run(
      ["auth", "login", "--api-url", "https://prod.example", "--env", "prod"],
      ctx(),
    );
    expect(requests[0].url).toBe("https://prod.example/api/auth/cli/start");
    expect(readConfigFile(file)).toMatchObject({
      apiUrl: "https://prod.example",
      env: "prod",
      token: "nry_access",
    });
  });

  it("retires the session it replaced, so a re-login does not leave a live family behind", async () => {
    writeConfigFile(
      { token: "nry_old", refreshToken: "nryr_old", tenantId: "tenant-A" },
      file,
    );
    responses = [START_OK, AUTHORIZED, { status: 204 }];
    expect(await run(["auth", "login"], ctx())).toBe(0);

    const logout = requests.find((r) => r.url.includes("/logout"));
    expect(logout?.body).toEqual({
      refreshToken: "nryr_old",
      accessToken: "nry_old",
    });
    // The NEW session is what survives — the tidy-up must not touch it.
    expect(readConfigFile(file).refreshToken).toBe("nryr_refresh");
  });

  it("does not revoke a hand-pasted token when a browser login replaces it", async () => {
    writeConfigFile({ token: "nry_settings" }, file);
    responses = [START_OK, AUTHORIZED];
    expect(await run(["auth", "login"], ctx())).toBe(0);
    expect(requests.some((r) => r.url.includes("/logout"))).toBe(false);
  });

  it("labels the session with this device, so it is revocable in Settings", async () => {
    responses = [START_OK, AUTHORIZED];
    await run(["auth", "login"], ctx());
    expect(requests[0].body).toEqual({ hostname: "test-box" });
  });
});

describe("naary auth login --token (the hand-pasted path)", () => {
  it("still works, and makes no network call", async () => {
    expect(await run(["auth", "login", "--token", "nry_manual"], ctx())).toBe(
      0,
    );
    expect(requests).toHaveLength(0);
    expect(readConfigFile(file).token).toBe("nry_manual");
    expect(out.join("\n")).not.toContain("nry_manual"); // masked, never echoed whole
  });

  it("logging out of a PASTED token never sends it to the server to be deleted", async () => {
    // The discriminating case for `revokeByToken`: `--token` is a Settings/CI credential — often
    // shared with other systems, and the only route open to a plain member. `logout` means "forget
    // my local session"; deleting that token outright would be a different and much worse thing.
    await run(["auth", "login", "--token", "nry_settings"], ctx());
    expect(await run(["auth", "logout"], ctx())).toBe(0);
    expect(requests).toHaveLength(0);
    expect(readConfigFile(file).token).toBeUndefined();
    // And it must not CLAIM a revocation it did not perform: the token is still live, and telling
    // someone otherwise is the same false reassurance the offline branch is careful to avoid.
    expect(out.join("\n")).not.toContain("Session revoked");
    expect(out.join("\n")).toContain("nothing was revoked server-side");
  });

  it("clears a previous browser session rather than leaving its refresh token behind", async () => {
    // Otherwise the first 401 would rotate the user back onto the OLD session's credential —
    // a token they thought they had just replaced.
    writeConfigFile(
      { token: "nry_old", refreshToken: "nryr_old", tenantId: "tenant-A" },
      file,
    );
    await run(["auth", "login", "--token", "nry_manual"], ctx());
    expect(readConfigFile(file)).toEqual({ token: "nry_manual" });
  });
});

describe("naary auth status", () => {
  it("names where the token came from, and when it dies", async () => {
    writeConfigFile(
      {
        token: "nry_abcdefghij",
        refreshToken: "nryr_x",
        tokenExpiresAt: "2026-08-05T15:30:00.000Z",
        refreshTokenExpiresAt: "2026-11-03T00:00:00.000Z",
        tenantId: "tenant-A",
      },
      file,
    );
    expect(await run(["auth", "status"], ctx())).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("nry_…ghij");
    expect(text).not.toContain("nry_abcdefghij");
    expect(text).toContain("[from config file]");
    expect(text).toContain("(in 3h 30m)"); // clock is fixed at 12:00Z
    expect(text).toContain("stored");
    expect(text).toContain("tenant-A");
  });

  it("says plainly when there is nothing stored", async () => {
    expect(await run(["auth", "status"], ctx())).toBe(0);
    expect(out.join("\n")).toContain("(not set)");
  });
});

describe("naary auth logout", () => {
  it("revokes server-side, then forgets locally, keeping preferences", async () => {
    writeConfigFile(
      {
        apiUrl: "https://naary.example",
        env: "prod",
        token: "nry_access",
        refreshToken: "nryr_refresh",
      },
      file,
    );
    responses = [{ status: 204 }];
    expect(await run(["auth", "logout"], ctx())).toBe(0);

    expect(requests[0].url).toBe("https://naary.example/api/auth/cli/logout");
    expect(requests[0].body).toEqual({
      refreshToken: "nryr_refresh",
      accessToken: "nry_access",
    });
    expect(readConfigFile(file)).toEqual({
      apiUrl: "https://naary.example",
      env: "prod",
    });
  });

  it("still forgets the tokens when the server is unreachable, but says so and exits 1", async () => {
    writeConfigFile({ token: "nry_access", refreshToken: "nryr_x" }, file);
    const dead: FetchLike = async () => {
      throw new Error("ECONNREFUSED");
    };
    expect(await run(["auth", "logout"], ctx({ fetch: dead }))).toBe(1);
    // The local file is clean...
    expect(readConfigFile(file).token).toBeUndefined();
    // ...but the refresh family may be live for up to 90 days, which the user has to know.
    expect(err.join("\n")).toContain("still be live");
  });

  it("is a no-op when nothing is stored", async () => {
    expect(await run(["auth", "logout"], ctx())).toBe(0);
    expect(requests).toHaveLength(0);
    expect(out.join("\n")).toContain("Not logged in");
  });
});
