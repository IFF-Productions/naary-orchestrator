import "reflect-metadata";
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * CLI refresh tokens: ROTATION + reuse detection (#1078 §4, slice 2).
 *
 * The point of this file is NOT that a new row appears when you refresh — it is that the PRESENTED
 * token is dead afterwards, and that presenting a dead one past the grace window takes the whole
 * family down with it. Every test drives the real service through PLAINTEXT tokens, so the sha256
 * lookup is exercised for real.
 *
 * The in-memory table below deliberately implements `where` GENERICALLY (every key must match) —
 * if it only matched the keys the happy path needs, the `rotatedAt: null` compare-and-set guard
 * would be untested and could be deleted without a single test going red.
 */

interface Row {
  id: string;
  tenantId: string;
  userId: string;
  tokenHash: string;
  familyId: string;
  createdAt: Date;
  expiresAt: Date;
  lastUsedAt: Date | null;
  rotatedAt: Date | null;
  revokedAt: Date | null;
}

const { rows, cliRefreshToken, hooks } = vi.hoisted(() => {
  const rows: Row[] = [];
  /** One-shot interleaving hook: runs INSIDE updateMany, before it takes effect. Used to
   *  reproduce a concurrent rotation deterministically. */
  const hooks: { beforeUpdateMany?: () => Promise<void> } = {};
  let seq = 0;

  /** Generic predicate: EVERY key in `where` must equal the row's value. Dates compare by
   *  instant, everything else by identity. Unknown key ⇒ no match (fail closed). */
  const matches = (row: Row, where: Record<string, unknown>): boolean =>
    Object.entries(where).every(([k, want]) => {
      const got = (row as unknown as Record<string, unknown>)[k];
      if (want instanceof Date && got instanceof Date)
        return want.getTime() === got.getTime();
      return got === want;
    });

  return {
    rows,
    hooks,
    cliRefreshToken: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = {
          id: `row-${++seq}`,
          createdAt: new Date(),
          lastUsedAt: null,
          rotatedAt: null,
          revokedAt: null,
          ...data,
        } as unknown as Row;
        rows.push(row);
        return row;
      }),
      findUnique: vi.fn(
        async ({ where }: { where: Record<string, unknown> }) =>
          rows.find((r) => matches(r, where)) ?? null,
      ),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }) => {
          const hook = hooks.beforeUpdateMany;
          if (hook) {
            hooks.beforeUpdateMany = undefined; // one-shot: must not recurse
            await hook();
          }
          const hit = rows.filter((r) => matches(r, where));
          for (const r of hit) Object.assign(r, data);
          return { count: hit.length };
        },
      ),
    },
  };
});

vi.mock("@naary/db", () => ({ getPrisma: () => ({ cliRefreshToken }) }));

import {
  CLI_REFRESH_TOKEN_PREFIX,
  CliRefreshTokenService,
  REFRESH_ABSOLUTE_TTL_MS,
  REFRESH_IDLE_TTL_MS,
  REFRESH_ROTATION_GRACE_MS,
} from "../src/auth/cli-refresh-token.service";

const service = new CliRefreshTokenService();

const T0 = new Date("2026-08-04T12:00:00Z");
const at = (ms: number) => new Date(T0.getTime() + ms);
const SECOND = 1000;
const DAY = 24 * 60 * 60 * 1000;

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const rowFor = (token: string) =>
  rows.find((r) => r.tokenHash === sha256(token));
const liveRows = () => rows.filter((r) => r.revokedAt === null);

/** Force a successful rotation, asserting it succeeded, and hand back the successor. */
async function rotateOk(token: string, now: Date): Promise<string> {
  const res = await service.rotate(token, now);
  if (!res.ok) throw new Error(`expected rotate to succeed, got ${res.reason}`);
  return res.refreshToken;
}

beforeEach(() => {
  rows.length = 0;
  hooks.beforeUpdateMany = undefined;
  cliRefreshToken.create.mockClear();
  cliRefreshToken.findUnique.mockClear();
  cliRefreshToken.updateMany.mockClear();
});

// ---------------------------------------------------------------------------
// Storage: it is a credential, so only the hash may exist server-side.
// ---------------------------------------------------------------------------
describe("issue", () => {
  it("stores the sha256 and NEVER the plaintext", async () => {
    const { refreshToken } = await service.issue("tenant-A", "user-1", T0);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tokenHash).toBe(sha256(refreshToken));
    // Nothing persisted anywhere on the row may contain the secret.
    expect(JSON.stringify(rows[0])).not.toContain(refreshToken);
  });

  it("sets the 90-day absolute cap and opens a fresh family", async () => {
    const a = await service.issue("tenant-A", "user-1", T0);
    const b = await service.issue("tenant-A", "user-1", T0);
    expect(a.expiresAt).toEqual(at(REFRESH_ABSOLUTE_TTL_MS));
    // Two logins are two lineages — revoking one must not touch the other.
    expect(a.familyId).not.toBe(b.familyId);
  });

  it("uses a prefix no auth branch claims — a refresh token can never authenticate a request", async () => {
    const { refreshToken } = await service.issue("tenant-A", "user-1", T0);
    expect(refreshToken.startsWith(CLI_REFRESH_TOKEN_PREFIX)).toBe(true);
    // AuthGuard routes `nry_` to the API-token branch and `nrys_` to the SSO branch.
    expect(refreshToken.startsWith("nry_")).toBe(false);
    expect(refreshToken.startsWith("nrys_")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// THE slice: rotation actually invalidates the presented token.
// ---------------------------------------------------------------------------
describe("rotate — the old token dies", () => {
  it("issues a different successor in the same family, with the cap INHERITED not extended", async () => {
    const first = await service.issue("tenant-A", "user-1", T0);
    const res = await service.rotate(first.refreshToken, at(DAY));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.refreshToken).not.toBe(first.refreshToken);
    expect(res.familyId).toBe(first.familyId);
    expect(res.tenantId).toBe("tenant-A");
    expect(res.userId).toBe("user-1");
    // A fresh 90 days per rotation would make "90-day absolute" mean "forever".
    expect(res.expiresAt).toEqual(first.expiresAt);
    expect(rowFor(res.refreshToken)?.expiresAt).toEqual(first.expiresAt);
  });

  it("marks the presented token rotated, so re-presenting it past the grace window is REUSE", async () => {
    const first = await service.issue("tenant-A", "user-1", T0);
    await rotateOk(first.refreshToken, T0);
    expect(rowFor(first.refreshToken)?.rotatedAt).toEqual(T0);

    const replay = await service.rotate(
      first.refreshToken,
      at(REFRESH_ROTATION_GRACE_MS + 1),
    );
    expect(replay).toEqual({ ok: false, reason: "reused" });
  });

  it("reuse revokes the WHOLE family — the legitimate holder's live token dies too", async () => {
    const first = await service.issue("tenant-A", "user-1", T0);
    const second = await rotateOk(first.refreshToken, T0);
    const third = await rotateOk(second, at(SECOND));

    // The thief replays the oldest copy long after it was rotated.
    expect(
      await service.rotate(first.refreshToken, at(10 * SECOND + DAY)),
    ).toEqual({
      ok: false,
      reason: "reused",
    });

    // Every row in the lineage is revoked — including the token the real user is holding.
    expect(liveRows()).toHaveLength(0);
    expect(await service.rotate(third, at(11 * SECOND + DAY))).toEqual({
      ok: false,
      reason: "revoked",
    });
  });

  it("does not touch an UNRELATED family", async () => {
    const victim = await service.issue("tenant-A", "user-1", T0);
    const other = await service.issue("tenant-A", "user-1", T0);
    await rotateOk(victim.refreshToken, T0);
    await service.rotate(
      victim.refreshToken,
      at(REFRESH_ROTATION_GRACE_MS + 1),
    );
    // The second login is a different lineage and must survive.
    expect(rowFor(other.refreshToken)?.revokedAt).toBeNull();
    expect((await service.rotate(other.refreshToken, at(2 * DAY))).ok).toBe(
      true,
    );
  });

  it("refuses an unknown token", async () => {
    expect(await service.rotate("nryr_never-issued", T0)).toEqual({
      ok: false,
      reason: "unknown",
    });
    expect(rows).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The 60s grace window (#1078 §4): the concurrent-CLI race, not a replay.
// ---------------------------------------------------------------------------
describe("rotate — grace window", () => {
  it("accepts the previous token INSIDE the window and leaves the family alone", async () => {
    const first = await service.issue("tenant-A", "user-1", T0);
    const sibling1 = await rotateOk(first.refreshToken, T0);

    const res = await service.rotate(first.refreshToken, at(30 * SECOND));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.refreshToken).not.toBe(sibling1);
    expect(res.familyId).toBe(first.familyId);
    // Nothing was revoked: the other process's token still works.
    expect(liveRows()).toHaveLength(3);
    expect((await service.rotate(sibling1, at(31 * SECOND))).ok).toBe(true);
  });

  it("treats the boundary instant as still inside the window (>, not >=)", async () => {
    const first = await service.issue("tenant-A", "user-1", T0);
    await rotateOk(first.refreshToken, T0);
    expect(
      (await service.rotate(first.refreshToken, at(REFRESH_ROTATION_GRACE_MS)))
        .ok,
    ).toBe(true);
  });

  it("does NOT slide the window — accepting inside it cannot renew it", async () => {
    const first = await service.issue("tenant-A", "user-1", T0);
    await rotateOk(first.refreshToken, T0);
    // Accepted at +59s...
    expect((await service.rotate(first.refreshToken, at(59 * SECOND))).ok).toBe(
      true,
    );
    // ...but the window is still measured from the ORIGINAL rotation, so +61s is reuse. If
    // `rotatedAt` were re-stamped on the grace path, this would be a fresh 60s every replay.
    expect(await service.rotate(first.refreshToken, at(61 * SECOND))).toEqual({
      ok: false,
      reason: "reused",
    });
  });
});

// ---------------------------------------------------------------------------
// Lifetimes: 30-day idle, 90-day absolute.
// ---------------------------------------------------------------------------
describe("rotate — lifetimes", () => {
  it("refuses a token past the absolute cap", async () => {
    const first = await service.issue("tenant-A", "user-1", T0);
    expect(
      await service.rotate(first.refreshToken, at(REFRESH_ABSOLUTE_TTL_MS)),
    ).toEqual({ ok: false, reason: "expired" });
  });

  it("keeps the cap fixed across a chain of rotations", async () => {
    const first = await service.issue("tenant-A", "user-1", T0);
    let token = first.refreshToken;
    for (let day = 1; day <= 5; day++)
      token = await rotateOk(token, at(day * DAY));
    expect(rowFor(token)?.expiresAt).toEqual(at(REFRESH_ABSOLUTE_TTL_MS));
    // ...and the chain still dies on schedule, not 5 days later.
    expect(
      await service.rotate(token, at(REFRESH_ABSOLUTE_TTL_MS + SECOND)),
    ).toEqual({ ok: false, reason: "expired" });
  });

  it("refuses a token idle for more than 30 days, measured from the last use", async () => {
    const first = await service.issue("tenant-A", "user-1", T0);
    // Weekly use never re-authenticates...
    const week4 = await rotateOk(first.refreshToken, at(28 * DAY));
    // ...but a month of silence after that does.
    expect(
      await service.rotate(week4, at(28 * DAY + REFRESH_IDLE_TTL_MS + SECOND)),
    ).toEqual({ ok: false, reason: "idle_expired" });
  });

  it("accepts a token used exactly at the idle boundary", async () => {
    const first = await service.issue("tenant-A", "user-1", T0);
    expect(
      (await service.rotate(first.refreshToken, at(REFRESH_IDLE_TTL_MS))).ok,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Concurrency: the compare-and-set is what makes rotation single-use for real.
// ---------------------------------------------------------------------------
describe("rotate — concurrency", () => {
  it("two simultaneous refreshes both succeed, but only ONE claims the row", async () => {
    const first = await service.issue("tenant-A", "user-1", T0);
    const [a, b] = await Promise.all([
      service.rotate(first.refreshToken, T0),
      service.rotate(first.refreshToken, T0),
    ]);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.refreshToken).not.toBe(b.refreshToken);
    // Exactly one caller flipped rotatedAt null → now; the loser re-read and took the grace path.
    expect(rows.filter((r) => r.rotatedAt !== null)).toHaveLength(1);
    expect(liveRows()).toHaveLength(3); // the parent plus both successors
  });

  it("a caller that lost the race to a LONG-past rotation reports reuse, not success", async () => {
    // This is the test the `rotatedAt: null` guard in the CAS exists for. The caller reads a row
    // that still looks unrotated, another process rotates it, and by the time the caller writes,
    // the grace window has long passed. Without the guard it would mint a successor off a stale
    // read and the replay would go undetected.
    const first = await service.issue("tenant-A", "user-1", T0);
    hooks.beforeUpdateMany = async () => {
      await rotateOk(first.refreshToken, T0);
    };
    const res = await service.rotate(
      first.refreshToken,
      at(REFRESH_ROTATION_GRACE_MS + SECOND),
    );
    expect(res).toEqual({ ok: false, reason: "reused" });
    expect(liveRows()).toHaveLength(0);
  });

  it("fails CLOSED when the re-read shows no coherent rotation", async () => {
    // Pathological (a lost CAS whose row still reads unrotated). We must never mint on a row we
    // did not observe ourselves claim.
    const first = await service.issue("tenant-A", "user-1", T0);
    cliRefreshToken.updateMany.mockImplementationOnce(async () => ({
      count: 0,
    }));
    expect(await service.rotate(first.refreshToken, T0)).toEqual({
      ok: false,
      reason: "conflict",
    });
    expect(rows).toHaveLength(1); // nothing minted
  });
});

// ---------------------------------------------------------------------------
// revokeFamily — the primitive reuse detection (and, later, `naary logout`) uses.
// ---------------------------------------------------------------------------
describe("revokeFamily", () => {
  it("kills every live row in the lineage and reports how many", async () => {
    const first = await service.issue("tenant-A", "user-1", T0);
    const second = await rotateOk(first.refreshToken, T0);
    expect(await service.revokeFamily(first.familyId, at(SECOND))).toBe(2);
    expect(liveRows()).toHaveLength(0);
    expect(await service.rotate(second, at(2 * SECOND))).toEqual({
      ok: false,
      reason: "revoked",
    });
  });

  it("is idempotent and preserves the original revocation instant", async () => {
    const first = await service.issue("tenant-A", "user-1", T0);
    await service.revokeFamily(first.familyId, at(SECOND));
    expect(await service.revokeFamily(first.familyId, at(DAY))).toBe(0);
    expect(rowFor(first.refreshToken)?.revokedAt).toEqual(at(SECOND));
  });

  it("revocation wins over expiry — a killed family never reports as merely expired", async () => {
    const first = await service.issue("tenant-A", "user-1", T0);
    await service.revokeFamily(first.familyId, at(SECOND));
    expect(
      await service.rotate(
        first.refreshToken,
        at(REFRESH_ABSOLUTE_TTL_MS + DAY),
      ),
    ).toEqual({ ok: false, reason: "revoked" });
  });
});
