import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import { getPrisma } from "@naary/db";
import type { Principal } from "../auth/tenant.decorator";
import { PermissionsService } from "../permissions/permissions.service";

/** A tag's name may be at most this long (fits a chip; matches the DTO). */
export const MAX_TAG_NAME_LENGTH = 40;

/** One tag row + how many workflows carry it (for the manage/list UI). */
export interface TagView {
  id: string;
  name: string;
  color: string | null;
  workflowCount: number;
}

/** The tag identity a workflow row renders as a chip (no counts). */
export interface TagRef {
  id: string;
  name: string;
  color: string | null;
}

/**
 * Workflow tags (n8n parity, RBAC program slice T1) — organizational metadata that MAY carry
 * permissions: a TagGrant (RBAC-GROUPS.md §9, shipped) makes a 'selected'-scope grant cover
 * every workflow carrying the tag. Two consequences owned here:
 *  - GATING: while the tenant has zero TagGrants, attaching tags is the EDIT verb (today's
 *    behavior); the FIRST TagGrant makes tag membership access-bearing, so tag edits then
 *    require SHARE (promote) — otherwise any editor could grant themselves (or others)
 *    access by tagging a workflow.
 *  - CACHE: tag membership feeds the flattened effective-grant keys, so every
 *    access-relevant tag write invalidates the tenant's permissions cache.
 * Tags attach to (tenantId, workflowKey) TENANT-WIDE, not per environment: they're authoring
 * metadata like the workflow's name — identical in every env, so promote carries them
 * implicitly.
 */
@Injectable()
export class TagsService {
  constructor(@Optional() private readonly permissions?: PermissionsService) {}

  /** The tenant's tags with usage counts, name order (stable for pickers). */
  async list(tenantId: string): Promise<TagView[]> {
    const rows = await getPrisma().tag.findMany({
      where: { tenantId },
      orderBy: { name: "asc" },
      include: { _count: { select: { workflows: true } } },
    });
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      color: r.color,
      workflowCount: r._count.workflows,
    }));
  }

  /** Create a tag. Name is trimmed; a duplicate (tenantId, name) is a 409. */
  async create(
    tenantId: string,
    name: string,
    color?: string | null,
  ): Promise<TagView> {
    const trimmed = this.validName(name);
    const clash = await getPrisma().tag.findFirst({
      where: { tenantId, name: trimmed },
      select: { id: true },
    });
    if (clash) {
      throw new ConflictException(`A tag named '${trimmed}' already exists.`);
    }
    const row = await getPrisma().tag.create({
      data: { tenantId, name: trimmed, color: color ?? null },
    });
    return { id: row.id, name: row.name, color: row.color, workflowCount: 0 };
  }

  /** Rename/recolor ONE tag by id (tenant-scoped — the notifications updateChannel pattern:
   *  scoped existence check first, since `update` alone would key on the global id). */
  async update(
    tenantId: string,
    tagId: string,
    patch: { name?: string; color?: string | null },
  ): Promise<TagRef> {
    const existing = await getPrisma().tag.findFirst({
      where: { id: tagId, tenantId },
      select: { id: true },
    });
    if (!existing) {
      throw new NotFoundException("Unknown tag.");
    }
    let name: string | undefined;
    if (patch.name !== undefined) {
      name = this.validName(patch.name);
      const clash = await getPrisma().tag.findFirst({
        where: { tenantId, name, NOT: { id: tagId } },
        select: { id: true },
      });
      if (clash) {
        throw new ConflictException(`A tag named '${name}' already exists.`);
      }
    }
    const row = await getPrisma().tag.update({
      where: { id: tagId },
      data: { name, color: patch.color },
    });
    return { id: row.id, name: row.name, color: row.color };
  }

  /** Delete ONE tag by id (tenant-scoped deleteMany; idempotent). The FK cascade removes its
   *  WorkflowTag rows — workflows just lose the chip — AND its TagGrant rows, so any grant
   *  scoped to it silently narrows; the invalidation makes that visible immediately (and may
   *  flip the tenant's tag-edit gate back to edit if it was the last TagGrant). */
  async remove(tenantId: string, tagId: string): Promise<void> {
    await getPrisma().tag.deleteMany({ where: { id: tagId, tenantId } });
    this.permissions?.invalidateTenant(tenantId);
  }

  /**
   * REPLACE-SET the tags on one workflow key: validate every id belongs to the tenant (400
   * otherwise — never write a foreign tenant's tag id), then atomically delete the key's
   * existing rows and create the new set. Returns the applied tags (chip identities).
   */
  async setWorkflowTags(
    tenantId: string,
    workflowKey: string,
    tagIds: string[],
    /** With zero TagGrants in the tenant, tag editing is EDIT (§8.2 — today's behavior);
     *  with ≥1 TagGrant, tags carry access and it takes SHARE (promote) instead — gated
     *  against the caller's active env either way. */
    actor?: Principal,
    environmentId?: string,
  ): Promise<TagRef[]> {
    if (actor) {
      if (!this.permissions) {
        // Fail CLOSED: an actor implies a user-facing call site — authz must run.
        throw new Error("TagsService: PermissionsService is not wired");
      }
      if (await this.permissions.tenantHasTagGrants(tenantId)) {
        // Tags are access-bearing here: an edit-only member could otherwise grant
        // themselves (or others) access just by tagging a workflow.
        const allowed = await this.permissions.can(
          actor,
          "share",
          workflowKey,
          environmentId,
        );
        if (!allowed) {
          throw new ForbiddenException(
            "Tags carry permissions in this workspace — promoting rights (the Promote " +
              "permission on this workflow) are required to change them.",
          );
        }
      } else {
        await this.permissions.assertCan(
          actor,
          "edit",
          workflowKey,
          environmentId,
        );
      }
    }
    const unique = [...new Set(tagIds)];
    const owned = unique.length
      ? await getPrisma().tag.findMany({
          where: { id: { in: unique }, tenantId },
          select: { id: true, name: true, color: true },
        })
      : [];
    if (owned.length !== unique.length) {
      throw new BadRequestException(
        "One or more tag ids are unknown for this workspace.",
      );
    }
    const p = getPrisma();
    await p.$transaction([
      p.workflowTag.deleteMany({ where: { tenantId, workflowKey } }),
      p.workflowTag.createMany({
        data: unique.map((tagId) => ({ tagId, tenantId, workflowKey })),
      }),
    ]);
    // Tag membership feeds the flattened effective-grant keys (TagGrant expansion) — drop
    // the tenant's permissions cache so an access change is visible on the next request.
    this.permissions?.invalidateTenant(tenantId);
    // Preserve the caller's order (the UI's checkbox order) in the response.
    const byId = new Map(owned.map((t) => [t.id, t]));
    return unique.map((id) => {
      const t = byId.get(id) as {
        id: string;
        name: string;
        color: string | null;
      };
      return { id: t.id, name: t.name, color: t.color };
    });
  }

  /** Trim + bound the name (mirrors the DTO so service callers can't bypass it). */
  private validName(name: string): string {
    const trimmed = (name ?? "").trim();
    if (!trimmed) {
      throw new BadRequestException("Tag name must not be empty.");
    }
    if (trimmed.length > MAX_TAG_NAME_LENGTH) {
      throw new BadRequestException(
        `Tag name must be at most ${MAX_TAG_NAME_LENGTH} characters.`,
      );
    }
    return trimmed;
  }
}
