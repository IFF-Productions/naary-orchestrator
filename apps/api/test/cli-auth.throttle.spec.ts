import "reflect-metadata";
import type { AddressInfo } from "node:net";
import type { INestApplication } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import { ThrottlerModule } from "@nestjs/throttler";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * #1078 §5: "Rate-limit `/auth/cli/exchange` and `/auth/cli/refresh` — both are unauthenticated by
 * design (the token IS the credential), so they need the per-endpoint throttling already built for
 * the public form/chat surfaces."
 *
 * A `@Throttle()` decorator is metadata: it does nothing unless a ThrottlerGuard is actually in the
 * chain, and deleting it breaks no other test in this repo. So this boots the CLI controller behind
 * the REAL ClientIpThrottlerGuard — the same APP_GUARD app.module.ts registers — and drives a real
 * client past the limit. `/auth/cli/start` is the cheapest to prove (10/min); the same guard and the
 * same decorator mechanism carry exchange (60/min) and refresh (30/min).
 *
 * Its own file because the throttler is global state per app instance, and the isolation spec must
 * be free to make as many requests as it likes.
 */

vi.mock("@naary/db", () => ({ getPrisma: () => ({}) }));

import { ApiTokenService } from "../src/auth/api-token.service";
import { CliAuthRequestService } from "../src/auth/cli-auth-request.service";
import { CliAuthController } from "../src/auth/cli-auth.controller";
import { CliRefreshTokenService } from "../src/auth/cli-refresh-token.service";
import { ClientIpThrottlerGuard } from "../src/throttle/client-ip-throttler.guard";

let app: INestApplication;
let base: string;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [
      // Exactly app.module.ts's `default` bucket. The per-route override is what must bite first.
      ThrottlerModule.forRoot([{ name: "default", ttl: 60_000, limit: 120 }]),
    ],
    controllers: [CliAuthController],
    providers: [
      { provide: APP_GUARD, useClass: ClientIpThrottlerGuard },
      {
        provide: CliAuthRequestService,
        useValue: {
          start: async () => ({
            deviceCode: "nryd_x",
            userCode: "PQ4M-TWZ9",
            label: "naary CLI — dev-box",
            expiresAt: new Date(Date.now() + 600_000),
          }),
          // Always "keep polling" — the cheapest handler outcome, so the only thing that can end
          // the loop below is the limiter.
          claim: async () => ({ status: "pending" }),
        },
      },
      { provide: ApiTokenService, useValue: {} },
      {
        provide: CliRefreshTokenService,
        useValue: { rotate: async () => ({ ok: false, reason: "unknown" }) },
      },
    ],
  }).compile();

  app = moduleRef.createNestApplication();
  await app.init();
  await app.listen(0);
  base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
});

afterAll(async () => {
  await app?.close();
});

const call = (path: string, ip: string, body: unknown) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-real-ip": ip },
    body: JSON.stringify(body),
  });

const start = (ip: string) =>
  call("/auth/cli/start", ip, { hostname: "dev-box" });

/** Hammer a route from one client and report the statuses, in order. */
async function hammer(
  path: string,
  ip: string,
  body: unknown,
  times: number,
): Promise<number[]> {
  const statuses: number[] = [];
  for (let i = 0; i < times; i++) {
    statuses.push((await call(path, ip, body)).status);
  }
  return statuses;
}

describe("POST /auth/cli/start is rate-limited per client IP", () => {
  it("429s a caller that blows past the per-route limit", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      statuses.push((await start("203.0.113.10")).status);
    }
    // The route's own @Throttle (10/min) bites well before the global 120/min default.
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
    expect(statuses.slice(0, 10).every((s) => s === 201)).toBe(true);
  });

  it("keys on the REAL client IP, so one abusive caller does not lock out everyone else", async () => {
    // The previous test exhausted 203.0.113.10's bucket; a different client is unaffected.
    expect((await start("203.0.113.11")).status).toBe(201);
  });
});

/** The two §5 names explicitly. Each has its own @Throttle, and each would go unnoticed if deleted
 *  unless something drives past its limit. */
describe("the unauthenticated token endpoints are limited too", () => {
  it("429s a caller polling /auth/cli/exchange past 60/min", async () => {
    const statuses = await hammer(
      "/auth/cli/exchange",
      "203.0.113.20",
      { deviceCode: "nryd_whatever" },
      62,
    );
    // Well under the global 120/min default, so only the route's own limit can produce this.
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
    expect(statuses.slice(0, 60).every((s) => s === 200)).toBe(true);
  });

  it("429s a caller hammering /auth/cli/refresh past 30/min", async () => {
    const statuses = await hammer(
      "/auth/cli/refresh",
      "203.0.113.21",
      { refreshToken: "nryr_whatever" },
      32,
    );
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
    // Everything before the limit is the ordinary opaque refusal, not a 429.
    expect(statuses.slice(0, 30).every((s) => s === 401)).toBe(true);
  });
});
