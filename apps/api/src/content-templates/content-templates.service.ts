import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { getPrisma } from "@naary/db";
import { type TemplateBlock, templateBlocksSchema } from "@naary/dsl";

export interface ContentTemplateView {
  id: string;
  kind: "email" | "form";
  name: string;
  subject: string | null;
  blocks: TemplateBlock[];
}

/** Input for create/update — the caller supplies everything but the id + scope. */
export interface ContentTemplateInput {
  kind?: unknown;
  name?: unknown;
  subject?: unknown;
  blocks?: unknown;
}

const KINDS = ["email", "form"] as const;

function toView(row: {
  id: string;
  kind: string;
  name: string;
  subject: string | null;
  blocks: unknown;
}): ContentTemplateView {
  return {
    id: row.id,
    kind: row.kind as "email" | "form",
    name: row.name,
    subject: row.subject,
    // Validated on every write, so a stored row is always a well-formed block array.
    blocks: row.blocks as TemplateBlock[],
  };
}

/**
 * Reusable Form/Email content templates (docs/design/TEMPLATE-EDITOR.md), env-scoped like
 * Variables. DISTINCT from the built-in workflow starter-templates (`/templates`) — these are the
 * block-editor content a `sendEmail` node renders. The `blocks` array is validated against the DSL
 * block schema on every write, so a run renders a stored template without re-checking. NOT secrets
 * — non-secret copy ({{ $secrets.X }} still resolves in-activity at send).
 */
@Injectable()
export class ContentTemplatesService {
  async list(
    tenantId: string,
    environmentId: string,
  ): Promise<ContentTemplateView[]> {
    const rows = await getPrisma().template.findMany({
      where: { tenantId, environmentId },
      orderBy: { name: "asc" },
    });
    return rows.map(toView);
  }

  /** One template, scoped to (tenant, env) — 404 if absent or owned by another scope. */
  async get(
    tenantId: string,
    environmentId: string,
    id: string,
  ): Promise<ContentTemplateView> {
    const row = await getPrisma().template.findFirst({
      where: { id, tenantId, environmentId },
    });
    if (!row) throw new NotFoundException("Template not found");
    return toView(row);
  }

  async create(
    tenantId: string,
    environmentId: string,
    input: ContentTemplateInput,
  ): Promise<ContentTemplateView> {
    const { kind, name, subject, blocks } = this.validate(input);
    try {
      const row = await getPrisma().template.create({
        data: { tenantId, environmentId, kind, name, subject, blocks },
      });
      return toView(row);
    } catch (e) {
      throw this.mapWriteError(e, name);
    }
  }

  async update(
    tenantId: string,
    environmentId: string,
    id: string,
    input: ContentTemplateInput,
  ): Promise<ContentTemplateView> {
    await this.get(tenantId, environmentId, id); // 404 if not in this scope
    const { kind, name, subject, blocks } = this.validate(input);
    try {
      const row = await getPrisma().template.update({
        where: { id },
        data: { kind, name, subject, blocks },
      });
      return toView(row);
    } catch (e) {
      throw this.mapWriteError(e, name);
    }
  }

  /** Delete (no-op if absent). Scope-filtered so a caller can't delete another env's template. */
  async remove(
    tenantId: string,
    environmentId: string,
    id: string,
  ): Promise<void> {
    await getPrisma().template.deleteMany({
      where: { id, tenantId, environmentId },
    });
  }

  /** Validate + normalize input. Blocks are checked against the DSL schema so a malformed block
   *  never reaches storage (and thus never the renderer). */
  private validate(input: ContentTemplateInput): {
    kind: "email" | "form";
    name: string;
    subject: string | null;
    blocks: TemplateBlock[];
  } {
    const name = typeof input?.name === "string" ? input.name.trim() : "";
    if (!name) throw new BadRequestException("Template name is required.");
    const kind = input?.kind;
    if (kind !== "email" && kind !== "form") {
      throw new BadRequestException(
        `kind must be one of ${KINDS.join(" | ")}.`,
      );
    }
    const parsed = templateBlocksSchema.safeParse(input?.blocks ?? []);
    if (!parsed.success) {
      throw new BadRequestException(
        `Invalid template blocks: ${parsed.error.issues[0]?.message ?? "malformed"}`,
      );
    }
    const subject = typeof input?.subject === "string" ? input.subject : null;
    return { kind, name, subject, blocks: parsed.data as TemplateBlock[] };
  }

  /** A duplicate (tenant, env, name) is a 409, not a 500. */
  private mapWriteError(e: unknown, name: string): Error {
    if (
      e &&
      typeof e === "object" &&
      (e as { code?: string }).code === "P2002"
    ) {
      return new ConflictException(
        `A template named "${name}" already exists in this environment.`,
      );
    }
    return e as Error;
  }
}
