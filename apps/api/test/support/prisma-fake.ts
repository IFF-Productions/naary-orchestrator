import { vi } from "vitest";

/**
 * A minimal in-memory Prisma stand-in for specs that need to drive REAL services end to end.
 *
 * Extracted from `scim.write-isolation.spec.ts`, which grew it, when `membership-active.spec.ts`
 * needed the same thing. It models the handful of Prisma behaviours those paths actually depend
 * on — and it models them FAITHFULLY where the difference is load-bearing, which is the only
 * reason a fake is defensible here at all:
 *
 *  - `findUnique` requires a unique selector and IGNORES everything else in `where`, including a
 *    `tenantId` a caller believed was scoping the query. That is a real Prisma behaviour and a
 *    real class of cross-tenant bug;
 *  - `{ equals, mode: "insensitive" }`, `{ in }` and NESTED RELATION filters
 *    (`group: { tenantId }`, `membership: { active: true }`) all resolve, because tenant scoping
 *    and the #1115 liveness filter are both spelled that way;
 *  - column DEFAULTS apply on create, so a row the code inserts without naming a column comes
 *    out the way Postgres would produce it (`Invitation.acceptedAt` NULL, `Membership.active`
 *    true) rather than with the column absent — the difference between a test that proves
 *    something and one that passes because a field was undefined.
 *
 * NOT a Prisma emulator, and it should not become one: anything it cannot express is a signal
 * to write the test against `vitest.integration.config.ts`'s real Postgres instead.
 */
export type Row = Record<string, unknown>;

/** Does `row` satisfy every condition in `where`? */
export function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([k, cond]) => {
    if (cond === undefined) return true;
    if (cond !== null && typeof cond === "object") {
      const c = cond as { equals?: unknown; mode?: string; in?: unknown[] };
      if ("equals" in c) {
        const a = row[k];
        const b = c.equals;
        if (
          c.mode === "insensitive" &&
          typeof a === "string" &&
          typeof b === "string"
        ) {
          return a.toLowerCase() === b.toLowerCase();
        }
        return a === b;
      }
      if ("in" in c && Array.isArray(c.in)) {
        const v = row[k];
        if (c.mode === "insensitive" && typeof v === "string") {
          return c.in.some(
            (x) => typeof x === "string" && x.toLowerCase() === v.toLowerCase(),
          );
        }
        return c.in.includes(v);
      }
      // `label: { startsWith: "naary CLI" }` — the CLI-token filter on the access-token delete.
      if ("startsWith" in (cond as Row)) {
        const want = (cond as { startsWith: unknown }).startsWith;
        return typeof row[k] === "string" && typeof want === "string"
          ? (row[k] as string).startsWith(want)
          : false;
      }
      const nested = row[k];
      if (nested && typeof nested === "object") {
        return matches(nested as Row, cond as Row);
      }
      return false;
    }
    return row[k] === cond;
  });
}

/**
 * One fake table.
 *
 * @param rows          the seed array — the spec mutates it directly to set up and assert.
 * @param uniqueFields  the unique indexes `findUnique`/`upsert` may select on, compound ones as
 *                      `["userId", "tenantId"]` (matched as `userId_tenantId` too).
 * @param defaults      column DEFAULTS, applied on create/upsert-create — see the module doc.
 * @param now           the timestamp `createdAt`/`updatedAt` get.
 */
export function table(
  rows: Row[],
  uniqueFields: string[][] = [["id"]],
  defaults: Row = {},
  now: Date = new Date("2026-08-05T00:00:00Z"),
) {
  return {
    rows,
    findUnique: vi.fn(async ({ where }: { where: Row }) => {
      for (const fields of uniqueFields) {
        const compound = fields.length > 1 ? fields.join("_") : null;
        const sel: Row = {};
        if (compound && where[compound] !== undefined) {
          Object.assign(sel, where[compound] as Row);
        } else {
          let complete = true;
          for (const f of fields) {
            if (where[f] === undefined) complete = false;
            else sel[f] = where[f];
          }
          if (!complete) continue;
        }
        if (Object.keys(sel).length > 0) {
          return rows.find((r) => matches(r, sel)) ?? null;
        }
      }
      return null;
    }),
    findFirst: vi.fn(
      async ({ where }: { where: Row } = { where: {} }) =>
        rows.find((r) => matches(r, where)) ?? null,
    ),
    findMany: vi.fn(async ({ where }: { where?: Row } = {}) =>
      rows.filter((r) => matches(r, where)),
    ),
    count: vi.fn(
      async ({ where }: { where?: Row } = {}) =>
        rows.filter((r) => matches(r, where)).length,
    ),
    create: vi.fn(async ({ data }: { data: Row }) => {
      const row = {
        id: `row-${rows.length + 1}`,
        createdAt: now,
        ...defaults,
        ...data,
      };
      rows.push(row);
      return row;
    }),
    createMany: vi.fn(async ({ data }: { data: Row[] }) => {
      for (const d of data) rows.push({ createdAt: now, ...defaults, ...d });
      return { count: data.length };
    }),
    update: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
      const first = Object.values(where)[0] as Row;
      const sel = first?.constructor === Object ? first : where;
      const found = rows.find((r) => matches(r, sel));
      if (found) Object.assign(found, data);
      return found ?? null;
    }),
    upsert: vi.fn(
      async ({
        where,
        create,
        update,
      }: {
        where: Row;
        create: Row;
        update: Row;
      }) => {
        const first = Object.values(where)[0] as Row;
        const sel = first?.constructor === Object ? first : where;
        const found = rows.find((r) => matches(r, sel));
        if (found) {
          Object.assign(found, update);
          found.updatedAt = now;
          return found;
        }
        const row = {
          id: `row-${rows.length + 1}`,
          createdAt: now,
          updatedAt: now,
          ...defaults,
          ...create,
        };
        rows.push(row);
        return row;
      },
    ),
    updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
      const hit = rows.filter((r) => matches(r, where));
      for (const r of hit) Object.assign(r, data);
      return { count: hit.length };
    }),
    deleteMany: vi.fn(async ({ where }: { where: Row }) => {
      const keep = rows.filter((r) => !matches(r, where));
      const count = rows.length - keep.length;
      rows.length = 0;
      rows.push(...keep);
      return { count };
    }),
  };
}

/** Empty every table and clear every mock on it — one call in `beforeEach`. */
export function resetTables(tables: { rows: Row[] }[]): void {
  for (const t of tables) {
    t.rows.length = 0;
    for (const fn of Object.values(t)) {
      if (typeof fn === "function" && "mockClear" in fn) {
        (fn as { mockClear: () => void }).mockClear();
      }
    }
  }
}
