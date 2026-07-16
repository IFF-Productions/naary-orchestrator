import { BadRequestException, Injectable } from "@nestjs/common";
import { getPrisma } from "@naary/db";

export interface VariableView {
  key: string;
  value: string;
}

// Keys are referenced as `{{ $vars.KEY }}` and resolved via getByPath (dot-split), so a key must
// be a single identifier segment — no dots/spaces, not starting with a digit.
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Global Variables (enterprise backlog): non-secret, per-workspace + per-environment key/value
 * config, editable in Settings and referenced in string expressions as `{{ $vars.KEY }}`. The
 * worker loads a run's env variables into `ctx.$vars` at start. NOT secrets (those never enter
 * the graph/ctx — separate feature). Env-scoped so a value can differ sandbox vs prod.
 */
@Injectable()
export class VariablesService {
  /** All variables for a workspace+env, key-sorted. */
  async list(tenantId: string, environmentId: string): Promise<VariableView[]> {
    return getPrisma().variable.findMany({
      where: { tenantId, environmentId },
      orderBy: { key: "asc" },
      select: { key: true, value: true },
    });
  }

  /** Set (create or overwrite) a variable. Validates the key is a usable `$vars.` identifier. */
  async upsert(
    tenantId: string,
    environmentId: string,
    key: string,
    value: string,
  ): Promise<VariableView> {
    const k = (key ?? "").trim();
    if (!KEY_RE.test(k)) {
      throw new BadRequestException(
        "Variable key must be a valid identifier (letters, digits, underscore; not starting with a digit) — it's referenced as {{ $vars.KEY }}.",
      );
    }
    return getPrisma().variable.upsert({
      where: {
        tenantId_environmentId_key: { tenantId, environmentId, key: k },
      },
      create: { tenantId, environmentId, key: k, value: value ?? "" },
      update: { value: value ?? "" },
      select: { key: true, value: true },
    });
  }

  /** Delete a variable (no-op if absent). */
  async remove(
    tenantId: string,
    environmentId: string,
    key: string,
  ): Promise<void> {
    await getPrisma().variable.deleteMany({
      where: { tenantId, environmentId, key },
    });
  }
}
