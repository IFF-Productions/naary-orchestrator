import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ApiClient, ApiError, AuthError, type FetchLike } from "../src/client";
import { readConfigFile, writeConfigFile } from "../src/config";
import { defaultContext } from "../src/context";
import {
  SESSION_ENDED_MESSAGE,
  clearSession,
  refreshSession,
  revokeSession,
} from "../src/session";

/**
 * The refresh path — slices 1–3's whole point, from the client side.
 *
 * Why this spec exists at all: an access token now dies after twelve hours (#1078 §3), and slice 2
 * built rotating refresh tokens to survive that. If the CLI never calls `/auth/cli/refresh`, none
 * of that is reachable — the user simply re-authenticates every working day and slice 2 is dead
 * code that still carries all of its risk. So the assertions below are about the wiring: that a
 * 401 triggers exactly one refresh, that the retry carries the NEW bearer, that the ROTATED
 * refresh token is written back to disk, and that a family the server has revoked ends as an
 * instruction rather than a stack trace.
 *
 * Driven against a REAL http server, over real sockets, with a real temp config file, because the
 * failure this guards against (a hook that is never wired, a token written to a field the reader
 * whitelists away) is invisible to a mock.
 */

interface ServerState {
  /** Access tokens the fake API currently accepts. */
  live: Set<string>;
  /** refresh token → its successor. A token absent from here is dead (revoked/reused family). */
  chain: Map<string, string>;
  hits: Array<{ method: string; path: string; auth?: string; body?: string }>;
  /** Set to make /auth/cli/refresh answer 401, as it does for a revoked family. */
  refreshRevoked: boolean;
  /** Set to 401 every /v1 request, even one bearing a freshly-minted token. */
  rejectAll: boolean;
  logoutBodies: unknown[];
}

const state: ServerState = {
  live: new Set(),
  chain: new Map(),
  hits: [],
  refreshRevoked: false,
  rejectAll: false,
  logoutBodies: [],
};

/** Stands in for the deployment: nginx's `^/api/(.*)` rewrite in front of the API's route table. */
const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    const raw = Buffer.concat(chunks).toString("utf8");
    const pathname = new URL(req.url ?? "/", "http://x").pathname.replace(
      /^\/api(?=\/|$)/,
      "",
    );
    const auth = req.headers.authorization;
    state.hits.push({
      method: req.method ?? "GET",
      path: pathname,
      auth,
      body: raw,
    });
    const send = (status: number, body: unknown): void => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(body === undefined ? "" : JSON.stringify(body));
    };

    if (pathname === "/auth/cli/refresh") {
      const presented = (JSON.parse(raw || "{}") as { refreshToken?: string })
        .refreshToken;
      const next = presented ? state.chain.get(presented) : undefined;
      if (state.refreshRevoked || !next) {
        return send(401, {
          statusCode: 401,
          error: "invalid_grant",
          message: "That refresh token is no longer valid. Sign in again.",
        });
      }
      // Rotation: the presented token is dead from here on, exactly as slice 2 leaves it.
      state.chain.delete(presented as string);
      state.chain.set(next, `${next}-next`);
      const minted = `nry_access-for-${next}`;
      state.live.add(minted);
      return send(200, {
        status: "authorized",
        accessToken: minted,
        accessTokenExpiresAt: new Date(Date.now() + 43_200_000).toISOString(),
        refreshToken: next,
        refreshTokenExpiresAt: new Date(
          Date.now() + 7_776_000_000,
        ).toISOString(),
        tenantId: "tenant-A",
      });
    }

    if (pathname === "/auth/cli/logout") {
      state.logoutBodies.push(JSON.parse(raw || "{}"));
      res.writeHead(204);
      return res.end();
    }

    // Any /v1 route: authenticated by the bearer.
    const token = auth?.startsWith("Bearer ") ? auth.slice(7) : undefined;
    if (state.rejectAll || !token || !state.live.has(token)) {
      return send(401, { statusCode: 401, message: "Unauthorized" });
    }
    return send(200, { items: [{ id: "r1" }] });
  });
});

let origin = "";
let dir = "";
let file = "";

beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

/** A fresh temp HOME-ish config file per test — never the developer's ~/.naary. */
function tempConfig(contents: Record<string, string>): string {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "naary-cli-"));
  file = path.join(dir, "config.json");
  writeConfigFile(contents, file);
  return file;
}

afterEach(() => {
  state.live.clear();
  state.chain.clear();
  state.hits.length = 0;
  state.logoutBodies.length = 0;
  state.refreshRevoked = false;
  state.rejectAll = false;
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  dir = "";
});

const nodeFetch = globalThis.fetch as FetchLike;

describe("a 401 mid-command renews the session instead of failing it", () => {
  it("refreshes once, retries with the NEW bearer, and persists the rotated refresh token", async () => {
    state.chain.set("nryr_first", "nryr_second");
    const cfg = tempConfig({
      apiUrl: origin,
      token: "nry_expired",
      refreshToken: "nryr_first",
    });

    const client = new ApiClient(
      { apiUrl: origin, token: "nry_expired", tokenSource: "file" },
      nodeFetch,
      () => refreshSession({ apiUrl: origin, fetch: nodeFetch, file: cfg }),
    );

    // The command the user actually ran: it succeeds, and the expiry is invisible to them.
    await expect(client.request("/runs")).resolves.toEqual({
      items: [{ id: "r1" }],
    });

    const v1 = state.hits.filter((h) => h.path === "/v1/runs");
    expect(v1).toHaveLength(2);
    expect(v1[0].auth).toBe("Bearer nry_expired");
    // The retry must carry the token we just minted — a retry with the dead one is an infinite
    // "refresh and fail" that looks like a refresh bug only under load.
    expect(v1[1].auth).toBe("Bearer nry_access-for-nryr_second");

    // And the successor is on disk. Dropping it would leave us presenting a token the server has
    // already retired, which slice 2 reads as a LEAK and answers by revoking the whole family.
    const saved = readConfigFile(cfg);
    expect(saved.refreshToken).toBe("nryr_second");
    expect(saved.token).toBe("nry_access-for-nryr_second");
    expect(saved.tenantId).toBe("tenant-A");
    // Preferences that were in the file before the rotation survive it.
    expect(saved.apiUrl).toBe(origin);
  });

  it("retries exactly ONCE — a second 401 is a real authorization failure, not a stale token", async () => {
    state.chain.set("nryr_first", "nryr_second");
    const cfg = tempConfig({
      token: "nry_expired",
      refreshToken: "nryr_first",
    });
    // The refreshed token is not accepted either (e.g. the workspace no longer permits it).
    state.rejectAll = true;

    const client = new ApiClient(
      { apiUrl: origin, token: "nry_expired", tokenSource: "file" },
      nodeFetch,
      () => refreshSession({ apiUrl: origin, fetch: nodeFetch, file: cfg }),
    );
    const err = await client.request("/runs").catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(401);
    expect(
      state.hits.filter((h) => h.path === "/auth/cli/refresh"),
    ).toHaveLength(1);
    expect(state.hits.filter((h) => h.path === "/v1/runs")).toHaveLength(2);
  });

  it("a revoked family ends as 'log in again', not a stack trace — and the dead tokens are cleared", async () => {
    // What reuse detection leaves behind: the family is gone, so the stored token refreshes into a
    // 401. This is the moment a working CLI stops working, and it is the message that has to land.
    state.refreshRevoked = true;
    const cfg = tempConfig({
      token: "nry_expired",
      refreshToken: "nryr_leaked",
    });

    const client = new ApiClient(
      { apiUrl: origin, token: "nry_expired", tokenSource: "file" },
      nodeFetch,
      () => refreshSession({ apiUrl: origin, fetch: nodeFetch, file: cfg }),
    );
    const err = await client.request("/runs").catch((e) => e);
    if (!(err instanceof AuthError)) throw err;
    expect(err.message).toBe(SESSION_ENDED_MESSAGE);
    expect(err.message).toContain("naary auth login");

    // Dead credentials are removed, so the next command says "not logged in" rather than making
    // another futile round trip with a token that can never work again.
    const saved = readConfigFile(cfg);
    expect(saved.token).toBeUndefined();
    expect(saved.refreshToken).toBeUndefined();
  });

  it("keeps the session when refresh fails TRANSIENTLY — a 429 must not log the user out", async () => {
    // No chain entry and no revocation flag would 401; instead point at a server that is simply
    // unreachable, which is the shape of a transient failure.
    const cfg = tempConfig({
      token: "nry_expired",
      refreshToken: "nryr_first",
    });
    const flaky: FetchLike = async () => ({
      ok: false,
      status: 503,
      text: async () => "",
    });
    await expect(
      refreshSession({ apiUrl: origin, fetch: flaky, file: cfg }),
    ).resolves.toBeUndefined();
    expect(readConfigFile(cfg).refreshToken).toBe("nryr_first");
  });

  it("does nothing when there is no refresh token to spend", async () => {
    const cfg = tempConfig({ token: "nry_manual" });
    await expect(
      refreshSession({ apiUrl: origin, fetch: nodeFetch, file: cfg }),
    ).resolves.toBeUndefined();
    expect(state.hits).toHaveLength(0);
  });

  it("presents the refresh token as it is on disk NOW, not as it was at process start", async () => {
    // Two `naary` processes share one file; the other one rotated while we were working. Reading
    // late is what keeps us out of slice 2's 60-second grace window in the common case.
    state.chain.set("nryr_second", "nryr_third");
    const cfg = tempConfig({
      token: "nry_expired",
      refreshToken: "nryr_first",
    });
    writeConfigFile({ token: "nry_expired", refreshToken: "nryr_second" }, cfg);

    await expect(
      refreshSession({ apiUrl: origin, fetch: nodeFetch, file: cfg }),
    ).resolves.toBe("nry_access-for-nryr_third");
  });
});

describe("token provenance decides whether we may refresh at all", () => {
  it("never refreshes a token that came from NAARY_TOKEN — that credential is the caller's choice", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "naary-home-"));
    // A file session exists AND an env token is set. The env token wins; the file's refresh token
    // must not be spent to rotate a credential the user named explicitly (a CI token, typically).
    writeConfigFile(
      { token: "nry_file", refreshToken: "nryr_first" },
      path.join(home, ".naary", "config.json"),
    );
    state.chain.set("nryr_first", "nryr_second");

    const saved = { HOME: process.env.HOME, ...process.env };
    process.env.HOME = home;
    process.env.NAARY_TOKEN = "nry_from_env";
    process.env.NAARY_API_URL = origin;
    try {
      const { client, config } = defaultContext().makeClient({});
      expect(config.tokenSource).toBe("env");
      const err = await client.request("/runs").catch((e) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(401);
      expect(
        state.hits.filter((h) => h.path === "/auth/cli/refresh"),
      ).toHaveLength(0);
    } finally {
      process.env.HOME = saved.HOME;
      delete process.env.NAARY_TOKEN;
      delete process.env.NAARY_API_URL;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("logout", () => {
  it("hands the server BOTH credentials, so the session ends now rather than in 12 hours", async () => {
    const cfg = tempConfig({ token: "nry_live", refreshToken: "nryr_first" });
    await expect(
      revokeSession({ apiUrl: origin, fetch: nodeFetch, file: cfg }),
    ).resolves.toBe(true);
    expect(state.logoutBodies[0]).toEqual({
      refreshToken: "nryr_first",
      accessToken: "nry_live",
    });
  });

  it("reports failure rather than pretending, when the server cannot be reached", async () => {
    const cfg = tempConfig({ token: "nry_live", refreshToken: "nryr_first" });
    const dead: FetchLike = async () => {
      throw new Error("ECONNREFUSED");
    };
    await expect(
      revokeSession({ apiUrl: origin, fetch: dead, file: cfg }),
    ).resolves.toBe(false);
  });

  it("clearSession removes the credentials and keeps the preferences", () => {
    const cfg = tempConfig({
      apiUrl: "https://naary.example",
      env: "prod",
      token: "nry_live",
      refreshToken: "nryr_first",
      tokenExpiresAt: "2026-01-01T00:00:00.000Z",
      tenantId: "tenant-A",
    });
    clearSession(cfg);
    expect(readConfigFile(cfg)).toEqual({
      apiUrl: "https://naary.example",
      env: "prod",
    });
  });
});
