import { describe, expect, it } from "vitest";
import type { FetchLike } from "../src/client";
import { absoluteUri, deviceLogin } from "../src/device-login";

/**
 * The polling loop of `naary auth login`.
 *
 * This is the part of slice 4 with a way to be *quietly* wrong: a login that works on a developer
 * laptop while hammering `/auth/cli/exchange` looks identical to one that behaves, right up until
 * the endpoint's 60/min throttle (or a second CLI on the same IP) turns a normal login into a
 * failure. So the assertions here are about the WAITS, not just the outcome — what the loop slept,
 * how many times it called, and when it stopped.
 *
 * The clock and the sleep are fakes: `sleep` advances the same counter `now` reads, so a
 * ten-minute expiry window is exercised in microseconds and the deadline is checked exactly as it
 * would be against a real clock. No timers, no browser, no network.
 */

interface Reply {
  status?: number;
  body?: unknown;
  statusText?: string;
}

/** A scripted server: one queue of exchange replies, consumed in order (the last one repeats). */
function fakeServer(opts: { start?: Reply; exchange: Reply[] }): {
  fetch: FetchLike;
  calls: Array<{ url: string; body: unknown }>;
} {
  const calls: Array<{ url: string; body: unknown }> = [];
  let i = 0;
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, body: init?.body ? JSON.parse(init.body) : undefined });
    const reply = url.includes("/start")
      ? (opts.start ?? {
          status: 201,
          body: {
            deviceCode: "nryd_secret",
            userCode: "PQ4M-TWZ9",
            verificationUri: "/app/cli-login",
            expiresIn: 600,
            interval: 5,
          },
        })
      : (opts.exchange[Math.min(i++, opts.exchange.length - 1)] ?? {});
    const status = reply.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: reply.statusText,
      text: async () =>
        reply.body === undefined ? "" : JSON.stringify(reply.body),
    };
  };
  return { fetch, calls };
}

/** A clock whose only source of time is `sleep` — so every millisecond is one the loop asked for. */
function fakeClock() {
  let t = 1_000_000;
  const slept: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      slept.push(ms);
      t += ms;
    },
    slept,
  };
}

const prompts: unknown[] = [];
const login = (fetch: FetchLike, clock: ReturnType<typeof fakeClock>) =>
  deviceLogin({
    apiUrl: "https://naary.example",
    fetch,
    sleep: clock.sleep,
    now: clock.now,
    hostname: "dev-box",
    onPrompt: (p) => prompts.push(p),
  });

const exchanges = (calls: Array<{ url: string }>) =>
  calls.filter((c) => c.url.includes("/exchange"));

describe("the exchange poll honours the protocol", () => {
  it("waits the SERVER's interval between polls, and never polls before the first wait", async () => {
    const { fetch, calls } = fakeServer({
      exchange: [
        { body: { status: "pending" } },
        { body: { status: "pending" } },
        { body: { status: "authorized", accessToken: "nry_new" } },
      ],
    });
    const clock = fakeClock();
    const result = await login(fetch, clock);

    expect(result.ok).toBe(true);
    // Three polls, three waits — the loop sleeps BEFORE each one. An approval cannot have happened
    // in the microseconds after /start, so a poll before the first sleep is a wasted request
    // against a rate-limited endpoint.
    expect(clock.slept).toEqual([5000, 5000, 5000]);
    expect(exchanges(calls)).toHaveLength(3);
  });

  it("uses the interval the server sent, not a constant of ours", async () => {
    const { fetch } = fakeServer({
      start: {
        status: 201,
        body: {
          deviceCode: "nryd_x",
          userCode: "AAAA-BBBB",
          verificationUri: "https://app.example/app/cli-login",
          expiresIn: 600,
          // A server that widened its own throttle: the CLI must follow.
          interval: 11,
        },
      },
      exchange: [{ body: { status: "authorized", accessToken: "nry_ok" } }],
    });
    const clock = fakeClock();
    await login(fetch, clock);
    expect(clock.slept).toEqual([11000]);
  });

  it("backs off ADDITIVELY on 429 and keeps going — a throttle is not a failed login", async () => {
    const { fetch, calls } = fakeServer({
      exchange: [
        { status: 429, body: { message: "Too Many Requests" } },
        { status: 429, body: { message: "Too Many Requests" } },
        { body: { status: "pending" } },
        { body: { status: "authorized", accessToken: "nry_ok" } },
      ],
    });
    const clock = fakeClock();
    const result = await login(fetch, clock);

    expect(result.ok).toBe(true);
    // 5s, then +5 per 429, and — the part that matters — it does NOT decay back afterwards. The
    // throttle window is 60s wide; dropping straight back to 5s after it clears walks into the
    // same limit again a few polls later.
    expect(clock.slept).toEqual([5000, 10000, 15000, 15000]);
    expect(exchanges(calls)).toHaveLength(4);
  });

  it("backs off on a 5xx too, rather than hammering a server that is already unwell", async () => {
    const { fetch } = fakeServer({
      exchange: [
        { status: 503 },
        { body: { status: "authorized", accessToken: "nry_ok" } },
      ],
    });
    const clock = fakeClock();
    expect((await login(fetch, clock)).ok).toBe(true);
    expect(clock.slept).toEqual([5000, 10000]);
  });

  it("caps the back-off, so a long throttle cannot sleep through the whole window", async () => {
    // Twenty consecutive 429s: additive growth would reach 105s and blow past the 10-minute
    // window while an approval sat waiting.
    const { fetch } = fakeServer({
      exchange: [
        ...Array.from({ length: 20 }, () => ({ status: 429 })),
        { body: { status: "authorized", accessToken: "nry_ok" } },
      ],
    });
    const clock = fakeClock();
    await login(fetch, clock);
    expect(Math.max(...clock.slept)).toBeLessThanOrEqual(30000);
  });

  it("stops DEAD on a 400 — invalid_grant is terminal, and retrying only feeds the limiter", async () => {
    const { fetch, calls } = fakeServer({
      exchange: [
        {
          status: 400,
          body: {
            error: "invalid_grant",
            message: "That login request is invalid or has expired.",
          },
        },
        // Would be consumed if the loop wrongly continued.
        {
          body: { status: "authorized", accessToken: "nry_should_not_happen" },
        },
      ],
    });
    const clock = fakeClock();
    const result = await login(fetch, clock);

    expect(result.ok).toBe(false);
    expect(exchanges(calls)).toHaveLength(1);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("invalid");
    expect(result.message).toContain("naary auth login");
  });

  it("stops on denied, and says it was a refusal rather than a timeout", async () => {
    const { fetch, calls } = fakeServer({
      exchange: [
        { body: { status: "denied" } },
        { body: { status: "pending" } },
      ],
    });
    const result = await login(fetch, fakeClock());
    expect(exchanges(calls)).toHaveLength(1);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("denied");
    expect(result.message).toContain("refused");
  });

  it("gives up at the server's deadline instead of polling forever", async () => {
    // Never approved. The only thing that can stop this loop is `expiresIn`.
    const { fetch, calls } = fakeServer({
      start: {
        status: 201,
        body: {
          deviceCode: "nryd_x",
          userCode: "AAAA-BBBB",
          verificationUri: "/app/cli-login",
          expiresIn: 60,
          interval: 5,
        },
      },
      exchange: [{ body: { status: "pending" } }],
    });
    const clock = fakeClock();
    const result = await login(fetch, clock);

    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("expired");
    expect(result.message).toContain("expired");
    // 60s window at 5s: twelve polls, then the thirteenth wait crosses the deadline and stops.
    expect(exchanges(calls)).toHaveLength(11);
    expect(clock.slept).toHaveLength(12);
  });

  it("clamps a nonsense interval instead of busy-looping into the rate limit", async () => {
    const { fetch } = fakeServer({
      start: {
        status: 201,
        body: {
          deviceCode: "nryd_x",
          userCode: "AAAA-BBBB",
          verificationUri: "/app/cli-login",
          expiresIn: 600,
          interval: 0,
        },
      },
      exchange: [{ body: { status: "authorized", accessToken: "nry_ok" } }],
    });
    const clock = fakeClock();
    await login(fetch, clock);
    expect(clock.slept[0]).toBeGreaterThanOrEqual(1000);
  });
});

describe("what the human is shown", () => {
  it("prints the code and an ABSOLUTE url, even though the server may return a path", async () => {
    prompts.length = 0;
    const { fetch } = fakeServer({
      exchange: [{ body: { status: "authorized", accessToken: "nry_ok" } }],
    });
    await login(fetch, fakeClock());
    // `/start` returned the relative "/app/cli-login" (what the API serves with no APP_BASE_URL
    // configured) — a path is not something a user can open.
    expect(prompts[0]).toMatchObject({
      verificationUri: "https://naary.example/app/cli-login",
      userCode: "PQ4M-TWZ9",
      expiresIn: 600,
      browserOpened: false,
    });
  });

  it("never puts the device code in the url it shows or opens", async () => {
    prompts.length = 0;
    const { fetch } = fakeServer({
      exchange: [{ body: { status: "authorized", accessToken: "nry_ok" } }],
    });
    await login(fetch, fakeClock());
    const shown = (prompts[0] as { verificationUri: string }).verificationUri;
    expect(shown).not.toContain("nryd_");
  });

  it("a browser that refuses to launch does not fail the login", async () => {
    const { fetch } = fakeServer({
      exchange: [{ body: { status: "authorized", accessToken: "nry_ok" } }],
    });
    const clock = fakeClock();
    const seen: Array<{ browserOpened: boolean }> = [];
    const result = await deviceLogin({
      apiUrl: "https://naary.example",
      fetch,
      sleep: clock.sleep,
      now: clock.now,
      hostname: "dev-box",
      openBrowser: () => {
        throw new Error("no display");
      },
      onPrompt: (p) => seen.push(p),
    });
    expect(result.ok).toBe(true);
    expect(seen[0].browserOpened).toBe(false);
  });
});

describe("absoluteUri", () => {
  it("leaves an absolute uri alone and resolves a relative one against the api url", () => {
    expect(absoluteUri("https://x.example/", "https://app.example/p")).toBe(
      "https://app.example/p",
    );
    expect(absoluteUri("https://x.example/", "/app/cli-login")).toBe(
      "https://x.example/app/cli-login",
    );
  });
});

describe("/start failures surface, rather than becoming a silent poll", () => {
  it("throws when the server rejects the handshake", async () => {
    const { fetch } = fakeServer({
      start: { status: 429, body: { message: "Too Many Requests" } },
      exchange: [],
    });
    await expect(login(fetch, fakeClock())).rejects.toThrow(/429/);
  });

  it("throws when the response is not a naary handshake at all", async () => {
    const { fetch } = fakeServer({
      start: { status: 200, body: { hello: "world" } },
      exchange: [],
    });
    await expect(login(fetch, fakeClock())).rejects.toThrow(/login code/);
  });
});
