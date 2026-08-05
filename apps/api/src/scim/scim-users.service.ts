import { Injectable } from "@nestjs/common";
import { getPrisma } from "@naary/db";
import { parsePaging, parseScimFilter } from "./scim-filter";
import {
  SCIM_USER_SCHEMA,
  type ScimListResponse,
  type ScimUser,
  scimList,
} from "./scim-user.response";
import { ScimError } from "./scim.errors";

/** One directory subject in one workspace, normalised across the two rows it can live in. */
interface Subject {
  /** Lowercased — the canonical key. See `canonical` below. */
  email: string;
  /** Firebase uid, once they have signed in and hold a Membership. */
  userId: string | null;
  /** true = accepted Membership; false = still-pending Invitation. */
  active: boolean;
  createdAt: Date;
}

/**
 * Emails are canonicalised to lowercase everywhere in this module.
 *
 * `Membership.email` records whatever case the user joined with and an IdP may assert
 * another (the same reason MembershipService.findByEmail is case-insensitive). Since the
 * lowercased email is the ScimIdentity key, canonicalising is what stops `Alice@a.example`
 * and `alice@a.example` from forking into two stable ids for one human — which an IdP would
 * read as two users and try to reconcile forever.
 */
const canonical = (email: string): string => email.trim().toLowerCase();

/**
 * The SCIM read surface (#1075 slice 1).
 *
 * EVERY method takes `tenantId` as its first argument and that value comes only from the
 * verified ScimConnection row — never from a path segment, header, query or body. There is
 * deliberately no tenant-less variant of anything here, for the same reason
 * MembershipService.findByEmail refuses to have one.
 */
@Injectable()
export class ScimUsersService {
  /**
   * The reconcile GET. Returns Memberships AND pending Invitations as ONE namespace,
   * distinguished by `active` — see the `ScimUser.active` docstring for why omission is the
   * dangerous option.
   *
   * The union is assembled in memory because the two sources are different tables with no
   * join key but the email, and a workspace's directory is team-sized (hundreds), not
   * user-generated data. If that ever stops being true this becomes a UNION query; it is not
   * true yet, and pretending otherwise would buy a keyset-pagination design nobody needs.
   */
  async list(
    tenantId: string,
    opts: {
      filter?: string;
      startIndex?: string | number;
      count?: string | number;
    },
  ): Promise<ScimListResponse> {
    const filter = parseScimFilter(opts.filter);
    const { start, count } = parsePaging(opts.startIndex, opts.count);

    const prisma = getPrisma();
    const [members, invites] = await Promise.all([
      prisma.membership.findMany({
        where: { tenantId },
        select: { userId: true, email: true, createdAt: true },
      }),
      prisma.invitation.findMany({
        // `acceptedAt: null` is what makes it PENDING — an accepted invitation is already
        // represented by the Membership it created, and listing both would double-count.
        where: { tenantId, acceptedAt: null },
        select: { email: true, createdAt: true },
      }),
    ]);

    // Invitations first, memberships second: a subject who is both (an invitation that has
    // been accepted but whose row lingers) must appear ONCE, as the member — the stronger,
    // more current fact.
    const byEmail = new Map<string, Subject>();
    for (const inv of invites) {
      if (!inv.email) continue;
      byEmail.set(canonical(inv.email), {
        email: canonical(inv.email),
        userId: null,
        active: false,
        createdAt: inv.createdAt,
      });
    }
    for (const m of members) {
      if (!m.email) continue; // pre-Membership.email rows have nothing to key on
      byEmail.set(canonical(m.email), {
        email: canonical(m.email),
        userId: m.userId,
        active: true,
        createdAt: m.createdAt,
      });
    }

    let subjects = [...byEmail.values()];
    if (filter) subjects = subjects.filter((s) => s.email === filter.userName);
    // Deterministic order, so `startIndex` means the same thing across two requests.
    subjects.sort((a, b) =>
      a.email < b.email ? -1 : a.email > b.email ? 1 : 0,
    );

    const total = subjects.length;
    const page = subjects.slice(start - 1, start - 1 + count);
    const resources = await Promise.all(
      page.map((s) => this.resolveIdentity(tenantId, s)),
    );
    return scimList(resources, total, start);
  }

  /**
   * Fetch one resource by the id the IdP stored.
   *
   * THE TENANT SCOPING IS THE WHOLE POINT: this is `findFirst({ id, tenantId })` and never
   * `findUnique({ id })`. `findUnique` matches on the unique field alone and silently ignores
   * any other key in the `where`, so the obvious spelling of "get by id" would hand tenant A
   * tenant B's user — the exact failure apps/api/test/scim.isolation.spec.ts exists to catch.
   */
  async get(tenantId: string, id: string): Promise<ScimUser> {
    const identity = await getPrisma().scimIdentity.findFirst({
      where: { id, tenantId },
    });
    // Same 404 for "no such id" and "another workspace's id" — see ScimError.notFound.
    if (!identity) throw ScimError.notFound();

    const subject = await this.subjectFor(tenantId, identity.email);
    if (!subject) throw ScimError.notFound();
    return this.render(identity, subject);
  }

  /** The live state behind an identity row: a Membership (active) or a pending Invitation. */
  private async subjectFor(
    tenantId: string,
    email: string,
  ): Promise<Subject | null> {
    const prisma = getPrisma();
    const member = await prisma.membership.findFirst({
      where: { tenantId, email: { equals: email, mode: "insensitive" } },
      select: { userId: true, email: true, createdAt: true },
    });
    if (member?.email) {
      return {
        email: canonical(member.email),
        userId: member.userId,
        active: true,
        createdAt: member.createdAt,
      };
    }
    const invite = await prisma.invitation.findFirst({
      where: {
        tenantId,
        acceptedAt: null,
        email: { equals: email, mode: "insensitive" },
      },
      select: { email: true, createdAt: true },
    });
    if (invite?.email) {
      return {
        email: canonical(invite.email),
        userId: null,
        active: false,
        createdAt: invite.createdAt,
      };
    }
    return null;
  }

  /**
   * Materialise (or refresh) the STABLE resource id for a subject.
   *
   * This is a write on a read path, and it is deliberate: the id an IdP stores after its
   * first reconcile GET is used for every later PATCH/DELETE, so it has to exist before the
   * first read returns, and it has to be the same id after the subject's Invitation becomes a
   * Membership. Deriving it instead (say, a hash of the email) would look cheaper and would
   * break the moment slice 2 supports changing a userName.
   *
   * It is idempotent, tenant-scoped, upserted on the (tenantId, email) unique index — so
   * concurrent reconcile GETs converge rather than racing — and it creates NO membership and
   * grants NO access. `userId` is refreshed opportunistically as subjects sign in.
   */
  private async resolveIdentity(
    tenantId: string,
    subject: Subject,
  ): Promise<ScimUser> {
    const identity = await getPrisma().scimIdentity.upsert({
      where: { tenantId_email: { tenantId, email: subject.email } },
      create: { tenantId, email: subject.email, userId: subject.userId },
      update: { userId: subject.userId },
    });
    return this.render(identity, subject);
  }

  private render(
    identity: {
      id: string;
      email: string;
      externalId?: string | null;
      createdAt: Date;
      updatedAt: Date;
    },
    subject: Subject,
  ): ScimUser {
    return {
      schemas: [SCIM_USER_SCHEMA],
      id: identity.id,
      ...(identity.externalId ? { externalId: identity.externalId } : {}),
      // The CANONICAL (lowercased) address, not whatever case the row happens to hold — the
      // userName an IdP filters on must be the userName we echo back.
      userName: subject.email,
      emails: [{ value: subject.email, primary: true }],
      active: subject.active,
      meta: {
        resourceType: "User",
        created: identity.createdAt.toISOString(),
        lastModified: identity.updatedAt.toISOString(),
        location: `/scim/v2/Users/${identity.id}`,
      },
    };
  }
}
