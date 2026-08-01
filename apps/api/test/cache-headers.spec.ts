import "reflect-metadata";
import { readFileSync } from "node:fs";
import { get as httpGet, type IncomingHttpHeaders } from "node:http";
import type { ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import {
  Controller,
  Get,
  type INestApplication,
  Req,
  Res,
} from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { Request, Response } from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyCacheHardening } from "../src/common/cache-headers";

/**
 * The API must not be conditionally cacheable (#1038).
 *
 * Production answered `GET /executions` with **304 Not Modified**: Express's ETag is ON by
 * default and nothing set `Cache-Control`, which makes a response *heuristically* cacheable — so
 * the browser (or the CDN in front of it) revalidated, and the SPA got a body-less 304 for a
 * request that expected data. `/executions` is authenticated, per-tenant, environment-scoped and
 * changes constantly; none of it may be reused from a cache.
 *
 * These are REAL HTTP round trips against two minimal Nest apps — one hardened, one not — because
 * "is there an ETag?" and "does a conditional request 304?" are properties of the HTTP stack, not
 * of any controller. The un-hardened app stays on purpose: it is the executable statement of the
 * bug, and it starts failing the moment the default changes under us.
 *
 * NB: requests go out over `node:http`, not `fetch`. Undici's fetch silently adds
 * `cache-control: no-cache` to any request carrying `if-none-match`, which makes Express treat it
 * as stale — a 304 could never be reproduced through it.
 */

@Controller()
class ProbeController {
  /** An ordinary authenticated JSON route (stands in for GET /executions). */
  @Get("runs")
  runs(): { items: string[] } {
    return { items: ["r1"] };
  }

  /**
   * The one endpoint that deliberately caches: an anonymous, content-addressed form asset
   * (forms.controller.ts `GET /forms/assets/:assetId`). Mirrored exactly — its own
   * `Cache-Control`, its own strong ETag and its own `If-None-Match` → 304 branch — so this
   * asserts the hardening doesn't steamroll a handler that opted in.
   */
  @Get("asset")
  asset(@Req() req: Request, @Res() res: Response): void {
    const etag = '"sha256-of-the-bytes"';
    res.setHeader("cache-control", "public, max-age=31536000, immutable");
    res.setHeader("etag", etag);
    const inm = req.headers["if-none-match"];
    if (typeof inm === "string" && inm.includes(etag)) {
      res.status(304).end();
      return;
    }
    res.setHeader("content-type", "image/png");
    res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  }

  /** An SSE-style route that writes its own headers (the graph/builder streams do this). */
  @Get("stream")
  stream(@Res() res: ServerResponse): void {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
    });
    res.end(": connected\n\n");
  }
}

interface Result {
  status: number;
  headers: IncomingHttpHeaders;
}

/** A GET whose headers are sent verbatim (see the fetch caveat above). */
function get(
  url: string,
  headers: Record<string, string> = {},
): Promise<Result> {
  return new Promise((resolve, reject) => {
    httpGet(url, { headers }, (res) => {
      res.resume();
      res.on("end", () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers }),
      );
    }).on("error", reject);
  });
}

async function start(harden: boolean): Promise<{
  app: INestApplication;
  base: string;
}> {
  const moduleRef = await Test.createTestingModule({
    controllers: [ProbeController],
  }).compile();
  const app = moduleRef.createNestApplication();
  if (harden) applyCacheHardening(app);
  await app.init();
  await app.listen(0);
  const { port } = app.getHttpServer().address() as AddressInfo;
  return { app, base: `http://127.0.0.1:${port}` };
}

let hardened: { app: INestApplication; base: string };
let plain: { app: INestApplication; base: string };

beforeAll(async () => {
  hardened = await start(true);
  plain = await start(false);
});

afterAll(async () => {
  await hardened?.app.close();
  await plain?.app.close();
});

describe("the un-hardened default (what #1038 was)", () => {
  it("emits an ETag and no Cache-Control, so a conditional request 304s", async () => {
    const first = await get(`${plain.base}/runs`);
    const etag = first.headers.etag;
    expect(etag).toBeTruthy();
    expect(first.headers["cache-control"]).toBeUndefined();

    const second = await get(`${plain.base}/runs`, {
      "if-none-match": etag as string,
    });
    expect(second.status).toBe(304);
  });
});

describe("applyCacheHardening", () => {
  it("sends Cache-Control: no-store and no ETag on an authenticated JSON route", async () => {
    const res = await get(`${hardened.base}/runs`);
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers.etag).toBeUndefined();
  });

  it("cannot be revalidated into a 304 — there is no validator to match", async () => {
    const res = await get(`${hardened.base}/runs`, {
      "if-none-match": '"anything"',
    });
    expect(res.status).toBe(200);
  });

  it("leaves a handler that deliberately caches alone (public form assets)", async () => {
    const res = await get(`${hardened.base}/asset`);
    expect(res.headers["cache-control"]).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(res.headers.etag).toBe('"sha256-of-the-bytes"');

    // Its own 304 branch still works — that route saves a whole S3 GetObject with it.
    const revalidated = await get(`${hardened.base}/asset`, {
      "if-none-match": '"sha256-of-the-bytes"',
    });
    expect(revalidated.status).toBe(304);
    expect(revalidated.headers["cache-control"]).toBe(
      "public, max-age=31536000, immutable",
    );
  });

  it("leaves a stream's own no-cache alone (writeHead wins over the default)", async () => {
    const res = await get(`${hardened.base}/stream`);
    expect(res.headers["cache-control"]).toBe("no-cache");
  });

  // Everything above tests the exported unit; this is the one line that makes it real. bootstrap()
  // self-invokes, so main.ts can't be imported into a spec — read it instead.
  it("is actually wired into the app's bootstrap", () => {
    const main = readFileSync(resolve(__dirname, "../src/main.ts"), "utf8");
    expect(main).toContain("applyCacheHardening(app)");
  });
});
