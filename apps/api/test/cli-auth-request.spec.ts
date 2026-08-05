import "reflect-metadata";
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The `naary auth` device-code handshake (#1078 §2 shape B, slice 3).
 *
 * The point of this file is NOT that a device code can be redeemed — it is that it can be redeemed
 * exactly ONCE, that a redeemed one is indistinguishable from one that never existed, and that the
 * identity bound to a request cannot be rebound to a different user by a second (or concurrent)
 * approval. Every test drives the real service through PLAINTEXT codes, so the sha256 lookup is
 * exercised for real.
 *
 * The in-memory table implements `where` GENERICALLY (every key must match, unknown key ⇒ no match)
 * for the same reason slice 2's does: if it only matched the keys the happy path needs, the
 * compare-and-set guards — which are the entire security of this slice — could be deleted without a
 * single test going red. The `beforeUpdateMany` hook is slice 2's, reused to interleave two callers
 * deterministically instead of hoping a race shows up.
 */

interface Row {
  id: string;
  deviceCodeHash: string;
  userCode: string;
  label: string;
  createdAt: Date;
  expiresAt: Date;
  approvedAt: Date | null;
  tenantId: string | null;
  userId: string | null;
  deniedAt: Date | null;
  consumedAt: Date | null;
}

const { rows, cliAuthRequest, hooks } = vi.hoisted(() => {
  const rows: Row[] = [];
  const hooks: {
    beforeUpdateMany?: () => Promise<void>;
    beforeCreate?: () => void;
  } = {};
  let seq = 0;

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
    cliAuthRequest: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const hook = hooks.beforeCreate;
        if (hook) {
          hooks.beforeCreate = undefined; // one-shot
          hook();
        }
        // Real UNIQUE constraints, because start() is supposed to survive a user-code collision.
        for (const key of ["deviceCodeHash", "userCode"] as const) {
          if (rows.some((r) => r[key] === data[key])) {
            throw Object.assign(new Error("Unique constraint failed"), {
              code: "P2002",
            });
          }
        }
        const row = {
          id: `req-${++seq}`,
          createdAt: new Date(),
          approvedAt: null,
          tenantId: null,
          userId: null,
          deniedAt: null,
          consumedAt: null,
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

vi.mock("@naary/db", () => ({ getPrisma: () => ({ cliAuthRequest }) }));

import {
  CLI_AUTH_REQUEST_TTL_MS,
  CLI_DEVICE_CODE_PREFIX,
  CLI_TOKEN_LABEL_PREFIX,
  CliAuthRequestService,
  type CliAuthDecisionResult,
  displayUserCode,
  normalizeUserCode,
  sanitizeHostname,
} from "../src/auth/cli-auth-request.service";

const service = new CliAuthRequestService();

const T0 = new Date("2026-08-05T12:00:00Z");
const at = (ms: number) => new Date(T0.getTime() + ms);

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const rowFor = (deviceCode: string) =>
  rows.find((r) => r.deviceCodeHash === sha256(deviceCode));

beforeEach(() => {
  rows.length = 0;
  hooks.beforeUpdateMany = undefined;
  hooks.beforeCreate = undefined;
  vi.clearAllMocks();
});

/** A started handshake, approved by `userId` in `tenantId` unless told otherwise. */
async function startAndApprove(
  tenantId: string,
  userId: string,
  now: Date = T0,
) {
  const started = await service.start("dev-box", now);
  const approved = await service.approve(
    started.userCode,
    tenantId,
    userId,
    now,
  );
  expect(approved.ok).toBe(true);
  return started;
}

describe("start()", () => {
  it("returns a prefixed device code + a typeable user code, and stores only the HASH", async () => {
    const started = await service.start("hassans-macbook", T0);

    expect(started.deviceCode.startsWith(CLI_DEVICE_CODE_PREFIX)).toBe(true);
    // Long enough that guessing it is not a threat model — this is what plays §2A's `state` role.
    expect(started.deviceCode.length).toBeGreaterThan(40);
    expect(started.userCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);

    const row = rowFor(started.deviceCode);
    expect(row).toBeDefined();
    // The plaintext device code must appear NOWHERE in the row.
    expect(JSON.stringify(row)).not.toContain(started.deviceCode);
    // The user code is stored canonically (no separator) — it is a lookup key, not a secret.
    expect(row?.userCode).toBe(started.userCode.replace("-", ""));
    expect(row?.label).toBe(`${CLI_TOKEN_LABEL_PREFIX}hassans-macbook`);
    expect(row?.expiresAt.getTime()).toBe(
      T0.getTime() + CLI_AUTH_REQUEST_TTL_MS,
    );
  });

  it("is prefixed distinctly from every AuthGuard bearer prefix, so a device code authenticates nothing", async () => {
    const { deviceCode } = await service.start(undefined, T0);
    expect(deviceCode.startsWith("nry_")).toBe(false);
    expect(deviceCode.startsWith("nrys_")).toBe(false);
    expect(deviceCode.startsWith("nryr_")).toBe(false);
  });

  it("survives a user-code collision instead of 500ing a login", async () => {
    hooks.beforeCreate = () => {
      throw Object.assign(new Error("Unique constraint failed"), {
        code: "P2002",
      });
    };
    const started = await service.start("dev-box", T0);
    expect(rowFor(started.deviceCode)).toBeDefined();
    expect(cliAuthRequest.create).toHaveBeenCalledTimes(2);
  });

  it("does not swallow a NON-unique DB error as a retryable collision", async () => {
    hooks.beforeCreate = () => {
      throw Object.assign(new Error("connection reset"), { code: "P1001" });
    };
    await expect(service.start("dev-box", T0)).rejects.toThrow(
      "connection reset",
    );
    expect(cliAuthRequest.create).toHaveBeenCalledTimes(1);
  });
});

describe("approve()", () => {
  it("binds the identity, and accepts the code as the human typed it", async () => {
    const started = await service.start("dev-box", T0);
    // Lower case, extra spaces, no separator — a human retyping from a terminal.
    const typed = ` ${started.userCode.replace("-", " ").toLowerCase()} `;

    const result = await service.approve(typed, "tenant-A", "user-a", T0);

    expect(result).toEqual({
      ok: true,
      label: `${CLI_TOKEN_LABEL_PREFIX}dev-box`,
    });
    const row = rowFor(started.deviceCode);
    expect(row?.tenantId).toBe("tenant-A");
    expect(row?.userId).toBe("user-a");
  });

  it("refuses a SECOND approval, and does not rebind the request to the second user", async () => {
    const started = await startAndApprove("tenant-A", "user-a");

    const second = await service.approve(
      started.userCode,
      "tenant-B",
      "user-b",
      T0,
    );

    expect(second).toEqual({ ok: false, reason: "already_decided" });
    const row = rowFor(started.deviceCode);
    expect(row?.tenantId).toBe("tenant-A");
    expect(row?.userId).toBe("user-a");
  });

  it("CONCURRENT approvals: exactly ONE is told it won, and the row matches that one", async () => {
    const started = await service.start("dev-box", T0);
    let interleaved: CliAuthDecisionResult | undefined;
    // Interleave: user-b's whole approval — read AND write — lands inside user-a's compare-and-set,
    // so both callers have read `approvedAt === null`. Without the CAS both are told `ok` and the
    // later write silently rebinds the request to the other user; that is the cross-user hole.
    hooks.beforeUpdateMany = async () => {
      interleaved = await service.approve(
        started.userCode,
        "tenant-B",
        "user-b",
        T0,
      );
    };

    const first = await service.approve(
      started.userCode,
      "tenant-A",
      "user-a",
      T0,
    );

    const results = [first, interleaved];
    expect(results.filter((r) => r?.ok === true)).toHaveLength(1);
    expect(results.filter((r) => r?.ok === false)).toHaveLength(1);
    // And the row is bound to the caller that was TOLD it won — never to the other one.
    const winner = first.ok ? "user-a" : "user-b";
    const row = rowFor(started.deviceCode);
    expect(row?.userId).toBe(winner);
    expect(row?.tenantId).toBe(winner === "user-a" ? "tenant-A" : "tenant-B");
    expect(rows.filter((r) => r.approvedAt !== null)).toHaveLength(1);
  });

  it("refuses an expired request, and an unknown or malformed code", async () => {
    const started = await service.start("dev-box", T0);
    expect(
      await service.approve(
        started.userCode,
        "tenant-A",
        "user-a",
        at(CLI_AUTH_REQUEST_TTL_MS + 1),
      ),
    ).toEqual({ ok: false, reason: "expired" });

    expect(
      await service.approve("ZZZZ-ZZZZ", "tenant-A", "user-a", T0),
    ).toEqual({ ok: false, reason: "unknown" });
    expect(await service.approve("nope", "tenant-A", "user-a", T0)).toEqual({
      ok: false,
      reason: "unknown",
    });
  });
});

describe("deny()", () => {
  it("is terminal: a denied request can no longer be approved, and claim() reports denied", async () => {
    const started = await service.start("dev-box", T0);

    expect((await service.deny(started.userCode, T0)).ok).toBe(true);
    expect(
      await service.approve(started.userCode, "tenant-A", "user-a", T0),
    ).toEqual({ ok: false, reason: "already_decided" });
    expect(await service.claim(started.deviceCode, T0)).toEqual({
      status: "denied",
    });
  });

  it("cannot undo an approval", async () => {
    const started = await startAndApprove("tenant-A", "user-a");
    expect(await service.deny(started.userCode, T0)).toEqual({
      ok: false,
      reason: "already_decided",
    });
  });
});

describe("claim() — the single-use gate", () => {
  it("reports pending until someone approves, then hands over the bound identity", async () => {
    const started = await service.start("dev-box", T0);
    expect(await service.claim(started.deviceCode, T0)).toEqual({
      status: "pending",
    });

    await service.approve(started.userCode, "tenant-A", "user-a", T0);

    expect(await service.claim(started.deviceCode, T0)).toEqual({
      status: "approved",
      tenantId: "tenant-A",
      userId: "user-a",
      label: `${CLI_TOKEN_LABEL_PREFIX}dev-box`,
    });
  });

  /**
   * The property the whole slice turns on. A REPLAYED code must not merely fail — it must fail the
   * SAME WAY a code that never existed fails, so that holding a spent one teaches an attacker
   * nothing about whether it was ever real.
   */
  it("is single-use, and a spent code is byte-identical to an unknown or expired one", async () => {
    const started = await startAndApprove("tenant-A", "user-a");
    expect((await service.claim(started.deviceCode, T0)).status).toBe(
      "approved",
    );

    const replayed = await service.claim(started.deviceCode, T0);
    const unknown = await service.claim("nryd_never-issued", T0);

    const expired = await startAndApprove("tenant-A", "user-a");
    const tooLate = await service.claim(
      expired.deviceCode,
      at(CLI_AUTH_REQUEST_TTL_MS + 1),
    );

    expect(replayed).toEqual({ status: "invalid" });
    expect(replayed).toEqual(unknown);
    expect(replayed).toEqual(tooLate);
  });

  it("CONCURRENT redemptions of the same approved code: exactly one is told `approved`", async () => {
    const started = await startAndApprove("tenant-A", "user-a");
    let interleaved: Awaited<ReturnType<typeof service.claim>> | undefined;
    // The second caller runs entirely inside the first's compare-and-set — both have already read
    // `consumedAt === null`, which is precisely the race the CAS exists to lose safely.
    hooks.beforeUpdateMany = async () => {
      interleaved = await service.claim(started.deviceCode, T0);
    };

    const first = await service.claim(started.deviceCode, T0);

    const approvals = [first, interleaved].filter(
      (r) => r?.status === "approved",
    );
    expect(approvals).toHaveLength(1);
    expect(
      [first, interleaved].filter((r) => r?.status === "invalid"),
    ).toHaveLength(1);
  });

  it("will not mint from an approval that sat unredeemed past the window", async () => {
    const started = await startAndApprove("tenant-A", "user-a");
    expect(
      await service.claim(started.deviceCode, at(CLI_AUTH_REQUEST_TTL_MS + 1)),
    ).toEqual({ status: "invalid" });
    // And it is not consumed by that attempt — it is simply dead.
    expect(rowFor(started.deviceCode)?.consumedAt).toBeNull();
  });

  it("does not treat a request approved for one workspace as approved for another", async () => {
    const a = await startAndApprove("tenant-A", "user-a");
    const b = await startAndApprove("tenant-B", "user-b");

    expect(await service.claim(a.deviceCode, T0)).toMatchObject({
      tenantId: "tenant-A",
      userId: "user-a",
    });
    expect(await service.claim(b.deviceCode, T0)).toMatchObject({
      tenantId: "tenant-B",
      userId: "user-b",
    });
  });
});

describe("input normalization", () => {
  it("normalizeUserCode accepts what a human types and rejects what is not a code", () => {
    expect(normalizeUserCode("pq4m-twz9")).toBe("PQ4MTWZ9");
    expect(normalizeUserCode(" PQ4M TWZ9 ")).toBe("PQ4MTWZ9");
    // Wrong length after cleaning ⇒ not a code at all (rather than a prefix match).
    expect(normalizeUserCode("PQ4M")).toBe("");
    expect(normalizeUserCode("PQ4MTWZ9X")).toBe("");
    // Ambiguous characters are not in the alphabet, so they are dropped, not mapped.
    expect(normalizeUserCode("PQ4M-TWZ0")).toBe("");
    expect(normalizeUserCode(undefined)).toBe("");
  });

  it("displayUserCode hyphenates for the terminal", () => {
    expect(displayUserCode("PQ4MTWZ9")).toBe("PQ4M-TWZ9");
  });

  it("sanitizeHostname allowlists — a hostname cannot smuggle markup, newlines or control bytes into a label", () => {
    expect(sanitizeHostname("hassans-macbook.local")).toBe(
      "hassans-macbook.local",
    );
    expect(sanitizeHostname("box\nX-Admin: 1")).toBe("box X-Admin 1");
    expect(sanitizeHostname("<script>alert(1)</script>")).toBe(
      "script alert 1 script",
    );
    expect(sanitizeHostname("\u001b[31mred\u001b[0m")).toBe("31mred 0m");
    expect(sanitizeHostname("   ")).toBe("unknown device");
    expect(sanitizeHostname(undefined)).toBe("unknown device");
    expect(sanitizeHostname("x".repeat(500))).toHaveLength(48);
  });
});
