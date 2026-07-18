import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { getPrisma } from "@naary/db";

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
 * Workflow tags (n8n parity, RBAC program slice T1) — ORGANIZATIONAL metadata only; tags carry
 * no permissions (tag-scoped grants are a future RBAC-GROUPS seam). Tags attach to
 * (tenantId, workflowKey) TENANT-WIDE, not per environment: they're authoring metadata like the
 * workflow's name — identical in every env, so promote carries them implicitly.
 */
@Injectable()
export class TagsService {
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
   *  WorkflowTag rows — workflows just lose the chip. */
  async remove(tenantId: string, tagId: string): Promise<void> {
    await getPrisma().tag.deleteMany({ where: { id: tagId, tenantId } });
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
  ): Promise<TagRef[]> {
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
