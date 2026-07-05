import { beforeEach, describe, expect, it, vi } from "vitest";
import { BadRequestException, ForbiddenException } from "@nestjs/common";

const create = vi.fn();
const findMany = vi.fn();
const deleteMany = vi.fn();
const findUnique = vi.fn();
const updateMany = vi.fn();
vi.mock("@naary/db", () => ({
  getPrisma: () => ({
    invitation: { create, findMany, deleteMany, findUnique, updateMany },
  }),
}));

import { InvitationsService } from "../src/invitations/invitations.service";
import type { MembershipService } from "../src/membership/membership.service";

const ensureMembership = vi.fn();
function makeService(): InvitationsService {
  return new InvitationsService({
    ensureMembership,
  } as unknown as MembershipService);
}

const HOUR = 3600_000;

beforeEach(() => {
  create.mockReset().mockImplementation(({ data }) => ({
    id: "inv-1",
    createdAt: new Date(),
    ...data,
  }));
  findMany.mockReset().mockResolvedValue([]);
  deleteMany.mockReset().mockResolvedValue({ count: 1 });
  findUnique.mockReset();
  updateMany.mockReset().mockResolvedValue({ count: 1 });
  ensureMembership.mockReset().mockResolvedValue(undefined);
});

describe("InvitationsService.create", () => {
  it("stores only the token HASH and returns the raw token once", async () => {
    const res = await makeService().create(
      "t-1",
      "Foo@Bar.COM",
      "member",
      "admin",
      "u-inviter",
    );
    expect(res.token).toMatch(/^[A-Za-z0-9_-]{20,}$/); // high-entropy raw token
    const data = create.mock.calls[0][0].data;
    // The stored hash is sha256 hex and is NOT the raw token.
    expect(data.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(data.tokenHash).not.toBe(res.token);
    // Email normalized (lowercased) for reliable recipient matching.
    expect(data.email).toBe("foo@bar.com");
    expect(data.expiresAt.getTime()).toBeGreaterThan(Date.now());
    // The view never leaks the hash.
    expect(res).not.toHaveProperty("tokenHash");
  });

  it("rejects granting 'owner' via an invite", async () => {
    await expect(
      makeService().create("t-1", "a@b.co", "owner", "owner", "u"),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("rejects granting a role at or above the inviter's (attack #4)", async () => {
    // admin cannot grant admin
    await expect(
      makeService().create("t-1", "a@b.co", "admin", "admin", "u"),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("lets an owner grant admin, and an admin grant member", async () => {
    await expect(
      makeService().create("t-1", "a@b.co", "admin", "owner", "u"),
    ).resolves.toMatchObject({ role: "admin" });
    await expect(
      makeService().create("t-1", "a@b.co", "member", "admin", "u"),
    ).resolves.toMatchObject({ role: "member" });
  });
});

describe("InvitationsService.list", () => {
  it("filters to pending + unexpired and never returns the hash", async () => {
    findMany.mockResolvedValue([
      {
        id: "inv-1",
        email: "a@b.co",
        role: "member",
        invitedBy: "u",
        tokenHash: "SECRET",
        expiresAt: new Date(Date.now() + HOUR),
        createdAt: new Date(),
      },
    ]);
    const res = await makeService().list("t-1");
    expect(findMany.mock.calls[0][0].where).toMatchObject({
      tenantId: "t-1",
      acceptedAt: null,
    });
    expect(res[0]).not.toHaveProperty("tokenHash");
    expect(res[0]).toMatchObject({ id: "inv-1", email: "a@b.co" });
  });
});

describe("InvitationsService.accept", () => {
  const pending = {
    id: "inv-1",
    tenantId: "t-1",
    email: "invitee@b.co",
    role: "member",
    acceptedAt: null,
    expiresAt: new Date(Date.now() + HOUR),
  };

  it("joins the workspace when the verified email matches", async () => {
    findUnique.mockResolvedValue({ ...pending });
    const res = await makeService().accept(
      "raw-token-value-1234567890",
      "u-9",
      "Invitee@B.co", // case-insensitive match
      true,
    );
    expect(res).toEqual({ tenantId: "t-1", role: "member" });
    expect(ensureMembership).toHaveBeenCalledWith(
      "u-9",
      "t-1",
      "member",
      "Invitee@B.co",
    );
  });

  it("rejects an unknown / expired / already-accepted token (opaque 400)", async () => {
    findUnique.mockResolvedValue(null);
    await expect(
      makeService().accept("x".repeat(24), "u", "a@b.co", true),
    ).rejects.toBeInstanceOf(BadRequestException);

    findUnique.mockResolvedValue({
      ...pending,
      expiresAt: new Date(Date.now() - HOUR),
    });
    await expect(
      makeService().accept("x".repeat(24), "u", "invitee@b.co", true),
    ).rejects.toBeInstanceOf(BadRequestException);

    findUnique.mockResolvedValue({ ...pending, acceptedAt: new Date() });
    await expect(
      makeService().accept("x".repeat(24), "u", "invitee@b.co", true),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(ensureMembership).not.toHaveBeenCalled();
  });

  it("rejects an unverified email", async () => {
    findUnique.mockResolvedValue({ ...pending });
    await expect(
      makeService().accept("x".repeat(24), "u", "invitee@b.co", false),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("rejects a verified email that isn't the intended recipient (attack #3)", async () => {
    findUnique.mockResolvedValue({ ...pending });
    await expect(
      makeService().accept("x".repeat(24), "u", "someone-else@b.co", true),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(ensureMembership).not.toHaveBeenCalled();
  });

  it("is single-use: a lost consume race (count 0) rejects and grants nothing", async () => {
    findUnique.mockResolvedValue({ ...pending });
    updateMany.mockResolvedValue({ count: 0 });
    await expect(
      makeService().accept("x".repeat(24), "u", "invitee@b.co", true),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(ensureMembership).not.toHaveBeenCalled();
  });
});
