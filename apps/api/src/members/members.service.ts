import { Injectable } from "@nestjs/common";
import { getPrisma } from "@naary/db";

export interface MemberView {
  id: string;
  email: string;
  role: string;
  createdAt: string;
}

/** Workspace member directory, per tenant. Not the identity source of truth
 *  (that's Firebase/API tokens) — a lightweight list for the Team screen. */
@Injectable()
export class MembersService {
  async list(tenantId: string): Promise<MemberView[]> {
    const rows = await getPrisma().member.findMany({
      where: { tenantId },
      orderBy: { createdAt: "asc" },
    });
    return rows.map(toView);
  }

  /** Add (or update the role of) a member, keyed by (tenantId, email). */
  async add(
    tenantId: string,
    email: string,
    role: string,
  ): Promise<MemberView> {
    const row = await getPrisma().member.upsert({
      where: { tenantId_email: { tenantId, email } },
      create: { tenantId, email, role },
      update: { role },
    });
    return toView(row);
  }

  async remove(tenantId: string, id: string): Promise<void> {
    // deleteMany (not delete) so removing an unknown/foreign id is a no-op, never a
    // cross-tenant delete or a 500.
    await getPrisma().member.deleteMany({ where: { tenantId, id } });
  }
}

function toView(r: {
  id: string;
  email: string;
  role: string;
  createdAt: Date;
}): MemberView {
  return {
    id: r.id,
    email: r.email,
    role: r.role,
    createdAt: r.createdAt.toISOString(),
  };
}
