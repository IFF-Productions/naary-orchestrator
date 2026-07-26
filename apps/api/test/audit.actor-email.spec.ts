import { beforeEach, describe, expect, it, vi } from "vitest";

const auditFindMany = vi.fn();
const membershipFindMany = vi.fn();
vi.mock("@naary/db", () => ({
  getPrisma: () => ({
    auditEvent: { findMany: auditFindMany, create: vi.fn() },
    membership: { findMany: membershipFindMany },
  }),
}));

import { AuditService } from "../src/audit/audit.service";

/**
 * The audit log stored `principal.subject` — a Firebase uid (or an `sso:…` id) — and the UI rendered it
 * raw, so every row read as an opaque identifier. The email is resolved from the actor's Membership.
 *
 * Resolved on READ, not stamped at write time, because that's what fixes rows ALREADY in the log; a
 * write-side change alone leaves the screen unchanged until new events accrue. The stored row is never
 * rewritten, so the log's integrity is untouched — only its presentation.
 */
function row(id: string, actor: string) {
  return {
    id,
    actor,
    action: "Saved a workflow",
    method: "POST",
    path: "/graphs",
    statusCode: 200,
    environmentId: null,
    createdAt: new Date("2026-07-26T10:00:00Z"),
  };
}

beforeEach(() => {
  auditFindMany.mockReset();
  membershipFindMany.mockReset();
  membershipFindMany.mockResolvedValue([]);
});

describe("actor email resolution", () => {
  it("resolves the email and keeps the stored id alongside it", async () => {
    auditFindMany.mockResolvedValue([row("a1", "uid-alice")]);
    membershipFindMany.mockResolvedValue([
      { userId: "uid-alice", email: "alice@acme.test" },
    ]);

    const [event] = await new AuditService().list("t-1");

    expect(event.actorEmail).toBe("alice@acme.test");
    // The stored actor is NOT rewritten — an audit log's actor must stay stable, and emails get
    // reassigned between people while ids don't.
    expect(event.actor).toBe("uid-alice");
  });

  /**
   * ONE query for the page, not one per row. The audit list serves up to 200 rows, so a per-row lookup
   * would be a 200-query page — and the failure mode is invisible (it just gets slow).
   */
  it("issues a single batched lookup for many rows", async () => {
    auditFindMany.mockResolvedValue([
      row("a1", "uid-alice"),
      row("a2", "uid-bob"),
      row("a3", "uid-alice"),
      row("a4", "api-token"),
    ]);
    membershipFindMany.mockResolvedValue([
      { userId: "uid-alice", email: "alice@acme.test" },
      { userId: "uid-bob", email: "bob@acme.test" },
    ]);

    const events = await new AuditService().list("t-1");

    expect(membershipFindMany).toHaveBeenCalledTimes(1);
    // Distinct ids only — a repeated actor isn't asked for twice.
    const where = membershipFindMany.mock.calls[0][0].where;
    expect([...where.userId.in].sort()).toEqual([
      "api-token",
      "uid-alice",
      "uid-bob",
    ]);
    expect(events.map((e) => e.actorEmail)).toEqual([
      "alice@acme.test",
      "bob@acme.test",
      "alice@acme.test",
      null,
    ]);
  });

  /**
   * Membership is PER-WORKSPACE and indexed on `userId` alone, so a lookup by id without the tenant
   * would reach across workspaces and could attribute an action to someone's email from a different
   * workspace entirely.
   */
  it("scopes the lookup to the tenant, not just the user id", async () => {
    auditFindMany.mockResolvedValue([row("a1", "uid-alice")]);
    await new AuditService().list("t-1");
    expect(membershipFindMany.mock.calls[0][0].where.tenantId).toBe("t-1");
  });

  it("leaves an API-token actor as-is (there is no membership to resolve)", async () => {
    auditFindMany.mockResolvedValue([row("a1", "api-token")]);
    const [event] = await new AuditService().list("t-1");
    expect(event.actor).toBe("api-token");
    expect(event.actorEmail).toBeNull();
  });

  /** `Membership.email` is nullable ("email at join time") — a member who predates the stamp has none,
   *  and that must surface as null rather than an invented placeholder. */
  it("returns null for a member whose stored email is null", async () => {
    auditFindMany.mockResolvedValue([row("a1", "uid-old")]);
    membershipFindMany.mockResolvedValue([{ userId: "uid-old", email: null }]);
    const [event] = await new AuditService().list("t-1");
    expect(event.actorEmail).toBeNull();
    expect(event.actor).toBe("uid-old");
  });

  it("returns null for an actor with no membership (a member who left)", async () => {
    auditFindMany.mockResolvedValue([row("a1", "uid-gone")]);
    const [event] = await new AuditService().list("t-1");
    expect(event.actorEmail).toBeNull();
  });

  it("makes no lookup at all when there are no events", async () => {
    auditFindMany.mockResolvedValue([]);
    expect(await new AuditService().list("t-1")).toEqual([]);
    expect(membershipFindMany).not.toHaveBeenCalled();
  });

  /** An `sso:…` subject IS the Membership.userId, so it resolves through the same path as a uid —
   *  which is why no "does this look like a uid?" discriminator is needed anywhere. */
  it("resolves an SSO actor id the same way", async () => {
    auditFindMany.mockResolvedValue([row("a1", "sso:conn-1:abc123")]);
    membershipFindMany.mockResolvedValue([
      { userId: "sso:conn-1:abc123", email: "fed@acme.test" },
    ]);
    const [event] = await new AuditService().list("t-1");
    expect(event.actorEmail).toBe("fed@acme.test");
  });
});
