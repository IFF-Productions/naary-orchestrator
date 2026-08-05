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
  label: string | null;
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
   *  instant, everything else by identity. `{ gt }` is the one operator the session list uses
   *  (the absolute-cap filter) and is implemented for real, because "which families are still
   *  alive" is precisely what that screen is asserting. Unknown key or unknown operator ⇒ no
   *  match (fail closed). */
  const matches = (row: Row, where: Record<string, unknown>): boolean =>
    Object.entries(where).every(([k, want]) => {
      const got = (row as unknown as Record<string, unknown>)[k];
      if (want instanceof Date && got instanceof Date)
        return want.getTime() === got.getTime();
      if (want && typeof want === "object" && !(want instanceof Date)) {
        return Object.entries(want as Record<string, unknown>).every(
          ([op, v]) =>
            op === "gt" && got instanceof Date && v instanceof Date && got > v,
        );
      }
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
          label: null,
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
      findFirst: vi.fn(
        async ({ where }: { where: Record<string, unknown> }) =>
          rows.find((r) => matches(r, where)) ?? null,
      ),
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        rows.filter((r) => matches(r, where)),
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

  it("detects reuse of a token rotated away LONGER AGO than the idle window", async () => {
    // The realistic leak: a copy from a month-old laptop backup or shell history, replayed while
    // the family is still very much alive. Rotation stamps `lastUsedAt` on the row it retires, so
    // this row's idle clock reads "40 days stale" — if the idle check ran before reuse detection
    // this would answer `idle_expired`, decline politely, and leave the thief's family refreshing.
    const first = await service.issue("tenant-A", "user-1", T0);
    let token = await rotateOk(first.refreshToken, T0);
    // The real user keeps working weekly, well past the 30-day idle window of the leaked copy.
    for (let week = 1; week <= 5; week++)
      token = await rotateOk(token, at(week * 7 * DAY));

    expect(await service.rotate(first.refreshToken, at(40 * DAY))).toEqual({
      ok: false,
      reason: "reused",
    });
    expect(liveRows()).toHaveLength(0);
    expect(await service.rotate(token, at(41 * DAY))).toEqual({
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

// ---------------------------------------------------------------------------
// listUserSessions — the Settings surface (#1078 §5).
//
// The claim under test is NOT "a query returns rows". It is that a person looking at that screen
// sees ONE entry per laptop (not one per rotation), that every entry shown is a session which could
// actually still refresh, and that the entries are theirs.
// ---------------------------------------------------------------------------
describe("listUserSessions", () => {
  it("collapses a whole rotation lineage into ONE session row", async () => {
    const first = await service.issue(
      "tenant-A",
      "user-1",
      T0,
      "naary CLI — laptop",
    );
    // Twelve hours apart — what a fortnight of daily use looks like: 14 rows, one laptop.
    const TWELVE_HOURS = 12 * 3600 * 1000;
    let token = first.refreshToken;
    for (let i = 1; i <= 13; i++) {
      token = await rotateOk(token, at(i * TWELVE_HOURS));
    }

    expect(rows).toHaveLength(14);
    const sessions = await service.listUserSessions(
      "tenant-A",
      "user-1",
      at(14 * TWELVE_HOURS),
    );
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      familyId: first.familyId,
      label: "naary CLI — laptop",
      // The family's FIRST row — "signed in a fortnight ago", not "created 12 hours ago".
      createdAt: T0,
      // ...and its NEWEST activity, which is the last refresh.
      lastUsedAt: at(13 * TWELVE_HOURS),
    });
  });

  it("shows one row per DEVICE — two logins are two sessions, newest first", async () => {
    await service.issue("tenant-A", "user-1", T0, "naary CLI — laptop");
    await service.issue(
      "tenant-A",
      "user-1",
      at(SECOND),
      "naary CLI — desktop",
    );
    const sessions = await service.listUserSessions(
      "tenant-A",
      "user-1",
      at(DAY),
    );
    // Newest activity first, so the device you just used is at the top.
    expect(sessions.map((s) => s.label)).toEqual([
      "naary CLI — desktop",
      "naary CLI — laptop",
    ]);
  });

  it("never shows a session `rotate()` would refuse — revoked, idle, or past the cap", async () => {
    const revoked = await service.issue("tenant-A", "user-1", T0, "revoked");
    await service.revokeFamily(revoked.familyId, at(SECOND));
    const alive = await service.issue("tenant-A", "user-1", T0, "alive");
    const idle = await service.issue("tenant-A", "user-1", T0, "idle");

    // A day in, everything unrevoked is live.
    expect(
      (await service.listUserSessions("tenant-A", "user-1", at(DAY))).map(
        (s) => s.label,
      ),
    ).toEqual(["alive", "idle"]);

    // Past the idle window with no refresh, both are dead — and `rotate` agrees, which is the
    // point: a row on this screen that could not refresh would let someone "revoke" nothing and
    // believe they had acted.
    const stale = at(REFRESH_IDLE_TTL_MS + DAY);
    expect(await service.listUserSessions("tenant-A", "user-1", stale)).toEqual(
      [],
    );
    expect((await service.rotate(idle.refreshToken, stale)).ok).toBe(false);

    // Keeping `alive` refreshed keeps it — and only it — on the screen.
    let token = alive.refreshToken;
    for (let d = 1; d <= 40; d++) token = await rotateOk(token, at(d * DAY));
    expect(
      (
        await service.listUserSessions(
          "tenant-A",
          "user-1",
          at(40 * DAY + SECOND),
        )
      ).map((s) => s.label),
    ).toEqual(["alive"]);

    // ...until the 90-day absolute cap, which no amount of use extends.
    expect(
      await service.listUserSessions(
        "tenant-A",
        "user-1",
        at(REFRESH_ABSOLUTE_TTL_MS + SECOND),
      ),
    ).toEqual([]);
  });

  it("scopes to the user AND the workspace — not one or the other", async () => {
    const mine = await service.issue("tenant-A", "user-1", T0, "mine");
    await service.issue(
      "tenant-A",
      "user-2",
      T0,
      "same workspace, other human",
    );
    await service.issue(
      "tenant-B",
      "user-1",
      T0,
      "same human, other workspace",
    );

    const sessions = await service.listUserSessions(
      "tenant-A",
      "user-1",
      at(DAY),
    );
    // Positive AND negative in one assertion: exactly one row, and it is the right one. A test that
    // only asserted "does not contain user-2's" would pass against a list that returned nothing.
    expect(sessions.map((s) => s.familyId)).toEqual([mine.familyId]);
  });

  it("renders a pre-label session as a session, not as a crash", async () => {
    // Rows minted before the `label` column existed (nullable, no backfill — inventing a device
    // name on a security screen would be a lie). The UI shows "Unknown device".
    const legacy = await service.issue("tenant-A", "user-1", T0);
    const [session] = await service.listUserSessions(
      "tenant-A",
      "user-1",
      at(DAY),
    );
    expect(session).toMatchObject({ familyId: legacy.familyId, label: null });
  });

  it("keeps the grace window's two live siblings as ONE session", async () => {
    // Inside REFRESH_ROTATION_GRACE_MS the same token mints twice (the concurrent-CLI race), so the
    // family briefly holds two unrotated rows. Grouping by family is what stops that surfacing as
    // "you are signed in twice on this laptop".
    const first = await service.issue(
      "tenant-A",
      "user-1",
      T0,
      "naary CLI — laptop",
    );
    await rotateOk(first.refreshToken, at(SECOND));
    await rotateOk(
      first.refreshToken,
      at(SECOND + REFRESH_ROTATION_GRACE_MS / 2),
    );
    expect(liveRows()).toHaveLength(3);
    expect(
      await service.listUserSessions("tenant-A", "user-1", at(DAY)),
    ).toHaveLength(1);
  });

  it("keeps the device label across every rotation", async () => {
    const first = await service.issue(
      "tenant-A",
      "user-1",
      T0,
      "naary CLI — laptop",
    );
    const next = await service.rotate(first.refreshToken, at(SECOND));
    // The successor carries it too, which is what lets the refreshed ACCESS token keep the device
    // name instead of degrading to an anonymous "naary CLI session" row in the token list.
    expect(next.ok && next.label).toBe("naary CLI — laptop");
    expect(
      (await service.listUserSessions("tenant-A", "user-1", at(DAY)))[0].label,
    ).toBe("naary CLI — laptop");
  });
});

// ---------------------------------------------------------------------------
// revokeUserFamily — the Revoke button. The ownership read IS the security.
// ---------------------------------------------------------------------------
describe("revokeUserFamily", () => {
  it("kills the whole family, and the live token stops refreshing", async () => {
    const first = await service.issue("tenant-A", "user-1", T0, "laptop");
    const live = await rotateOk(first.refreshToken, at(SECOND));

    expect(
      await service.revokeUserFamily(
        "tenant-A",
        "user-1",
        first.familyId,
        at(2 * SECOND),
      ),
    ).toBe(true);
    expect(
      await service.listUserSessions("tenant-A", "user-1", at(3 * SECOND)),
    ).toEqual([]);
    // The assertion that matters: the CLI holding the current token is actually signed out.
    expect(await service.rotate(live, at(3 * SECOND))).toEqual({
      ok: false,
      reason: "revoked",
    });
  });

  it("refuses another human's family in the SAME workspace, and leaves it untouched", async () => {
    const victim = await service.issue("tenant-A", "user-1", T0, "victim");
    const live = await rotateOk(victim.refreshToken, at(SECOND));

    expect(
      await service.revokeUserFamily(
        "tenant-A",
        "user-2",
        victim.familyId,
        at(2 * SECOND),
      ),
    ).toBe(false);
    // `revokeFamily` takes a BARE familyId, so "returned false" is not enough — read the rows.
    expect(
      rows
        .filter((r) => r.familyId === victim.familyId)
        .every((r) => r.revokedAt === null),
    ).toBe(true);
    expect((await service.rotate(live, at(3 * SECOND))).ok).toBe(true);
  });

  it("refuses the same human's family in ANOTHER workspace", async () => {
    // #1117's inverse: one consultant, two workspaces. Signing out of A must not reach B.
    const other = await service.issue("tenant-B", "user-1", T0, "other");
    expect(
      await service.revokeUserFamily(
        "tenant-A",
        "user-1",
        other.familyId,
        at(SECOND),
      ),
    ).toBe(false);
    expect(rowFor(other.refreshToken)?.revokedAt ?? null).toBeNull();
  });

  it("answers the same false for unknown and already-revoked — no probe for a real family id", async () => {
    const mine = await service.issue("tenant-A", "user-1", T0, "laptop");
    expect(
      await service.revokeUserFamily(
        "tenant-A",
        "user-1",
        mine.familyId,
        at(SECOND),
      ),
    ).toBe(true);
    expect(
      await service.revokeUserFamily(
        "tenant-A",
        "user-1",
        mine.familyId,
        at(DAY),
      ),
    ).toBe(false);
    expect(
      await service.revokeUserFamily(
        "tenant-A",
        "user-1",
        "no-such-family",
        at(DAY),
      ),
    ).toBe(false);
    // Idempotent: the second call must not restamp the first revocation.
    expect(rowFor(mine.refreshToken)?.revokedAt).toEqual(at(SECOND));
  });
});
