/**
 * MIGRATING THE FORKS THAT FAIL OPEN (#1016).
 *
 * #1015 fixed three shipped templates whose agent asked for JSON in the prompt and declared no
 * `outputSchema`, so every `output.<field>` they read downstream was `undefined` at run time.
 * The worst of them, `moderation`, failed OPEN: the human-review branch was unreachable and
 * every submission was auto-accepted.
 *
 * A template is copied at instantiation. Fixing the template fixed nothing for graphs a tenant
 * already forked from it, and they do not self-heal — this is the sweep that reaches them.
 *
 * ## The rules this sweep obeys, and why
 *
 *  - **DRY RUN IS THE DEFAULT.** `--apply` is required to write. A migration over tenant data
 *    whose first execution is also its first observation is not something anyone should run.
 *  - **Never mutates a version.** Versions are immutable and content-hashed; the fix is written
 *    as a NEW version through the ordinary `GraphsService.upsert`, so it is visible in version
 *    history and the tenant can roll back to the previous one like any other save.
 *  - **Latest version only.** Older versions are the history of what this workflow used to be.
 *    Rewriting them would be falsifying a record, and nothing runs them unless it is asked to.
 *  - **Idempotent.** A migrated node carries an `outputSchema`, so it no longer matches; and
 *    `upsert` is content-hash-guarded, so even a re-match would not mint a duplicate version.
 *  - **Per-workflow isolation.** `upsert` re-validates against TODAY's save gate, so a legacy
 *    graph can fail for a reason unrelated to this bug. That is reported and the sweep carries
 *    on — one odd graph must not abort a fleet-wide safety fix.
 *  - **Everything is logged, per tenant and workflow**, so the blast radius is a fact
 *    afterwards rather than an estimate.
 *
 * ## What it does NOT do
 *
 * Anything the predicate declines is REPORTED, never edited (`flagged` below). A schema-less
 * agent whose prompt merely mentions JSON is a legitimate authoring choice; the canvas issues
 * panel is where that gets raised, next to the node, to the person who can judge it.
 */
import type { GraphDef } from "@naary/dsl";
import { lintAgentOutputContract, migrateFailingOpenFork } from "@naary/dsl";
import type { GraphsService } from "./graphs.service";

/** The `savedBy` recorded on a migrated version. Shows up in the version-history list, so a
 *  tenant asking "who changed my workflow?" gets an answer that names the issue. */
export const MIGRATION_ACTOR = "naary-migration (#1016)";

/** One stored graph, as the sweep needs it. */
export interface GraphRow {
  tenantId: string;
  environmentId: string;
  workflowKey: string;
  name: string;
  version: number;
  graph: GraphDef;
}

/** A graph the predicate matched: it WILL be (or was) rewritten. */
export interface PlannedMigration {
  row: GraphRow;
  templateKey: string;
  agentNodeId: string;
  symptom: string;
  /** The corrected graph — the fork plus exactly the template's `outputSchema`. */
  graph: GraphDef;
  /** The note stored on the new version, and the line printed for it. */
  saveMessage: string;
}

/** A graph that looks related but is NOT rewritten — only reported. */
export interface FlaggedGraph {
  row: GraphRow;
  /** One line per warning: `<nodeId>: <message>`. */
  warnings: string[];
}

export interface MigrationPlan {
  migrations: PlannedMigration[];
  flagged: FlaggedGraph[];
  /** How many latest-version graphs were examined. */
  scanned: number;
}

/** The version note a migrated graph carries — the tenant's primary record of what happened. */
export function saveMessageFor(templateKey: string, symptom: string): string {
  return (
    `Automated fix (#1016): added the missing agent outputSchema this workflow's ` +
    `"${templateKey}" template shipped without. Symptom: ${symptom}. ` +
    "Only that one field changed; the previous version is still in this list if you want it back."
  );
}

/**
 * Decide what to do with each graph. PURE — no I/O, no writes, no clock. Every judgement the
 * sweep makes lives here, so it can be tested without a database.
 *
 * Callers must pass ONLY the latest version of each (tenant, environment, workflowKey).
 */
export function planMigration(rows: GraphRow[]): MigrationPlan {
  const migrations: PlannedMigration[] = [];
  const flagged: FlaggedGraph[] = [];
  for (const row of rows) {
    const fix = migrateFailingOpenFork(row.graph);
    if (fix) {
      migrations.push({
        row,
        templateKey: fix.fingerprint.templateKey,
        agentNodeId: fix.fingerprint.agentNodeId,
        symptom: fix.fingerprint.symptom,
        graph: fix.graph,
        saveMessage: saveMessageFor(
          fix.fingerprint.templateKey,
          fix.fingerprint.symptom,
        ),
      });
      continue;
    }
    // Not an exact fork. If it has the broader shape, say so — but never touch it.
    const warnings = lintAgentOutputContract(row.graph);
    if (warnings.length > 0) {
      flagged.push({
        row,
        warnings: warnings.map((w) => `${w.nodeId}: ${w.message}`),
      });
    }
  }
  return { migrations, flagged, scanned: rows.length };
}

/** What actually happened to one planned migration. */
export interface MigrationOutcome {
  plan: PlannedMigration;
  /** The version written, or the existing one when nothing needed writing. */
  version: number;
  /** True when a NEW version was created (false in dry-run, or if it was already current). */
  written: boolean;
  /** Present when the save failed — the sweep continues either way. */
  error?: string;
}

export interface MigrationReport {
  plan: MigrationPlan;
  outcomes: MigrationOutcome[];
  dryRun: boolean;
}

/**
 * Apply a plan. With `dryRun` (the default at every call site) nothing is written and the
 * outcome list records what WOULD have happened.
 *
 * Writes go through the ordinary `GraphsService.upsert`, deliberately: it re-validates the
 * graph, mints the next version number, refuses to touch a renamed key, and returns early on an
 * unchanged content hash. A migration that bypassed it to write rows directly would be a second
 * implementation of the one thing this system is careful about.
 */
export async function applyMigration(
  graphs: GraphsService,
  plan: MigrationPlan,
  opts: { dryRun?: boolean } = {},
): Promise<MigrationReport> {
  const dryRun = opts.dryRun ?? true;
  const outcomes: MigrationOutcome[] = [];
  for (const p of plan.migrations) {
    if (dryRun) {
      outcomes.push({ plan: p, version: p.row.version + 1, written: false });
      continue;
    }
    try {
      const snap = await graphs.upsert(
        p.row.tenantId,
        p.row.environmentId,
        p.row.workflowKey,
        p.row.name,
        p.graph,
        undefined, // no Principal: an actor triggers an RBAC assert this CLI cannot satisfy
        p.saveMessage,
        MIGRATION_ACTOR,
      );
      outcomes.push({
        plan: p,
        version: snap.version,
        written: snap.version > p.row.version,
      });
    } catch (err) {
      // One graph that today's save gate rejects (for reasons unrelated to this bug) must not
      // abort a fleet-wide safety fix. Reported, and the exit code reflects it.
      outcomes.push({
        plan: p,
        version: p.row.version,
        written: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { plan, outcomes, dryRun };
}

/**
 * The human-readable report — one line per affected workflow, per tenant, plus a summary. This
 * is the "log what changed, so the blast radius is a fact afterwards" requirement; keep it
 * greppable and keep the tenant/env/key on every line.
 */
export function formatReport(report: MigrationReport): string[] {
  const lines: string[] = [];
  const at = (r: GraphRow) =>
    `${r.tenantId}/${r.environmentId}/${r.workflowKey}`;
  const verb = report.dryRun ? "WOULD MIGRATE" : "MIGRATED";

  for (const o of report.outcomes) {
    const { row } = o.plan;
    if (o.error) {
      lines.push(`FAILED       ${at(row)} v${row.version} — ${o.error}`);
      continue;
    }
    if (!report.dryRun && !o.written) {
      lines.push(
        `UNCHANGED    ${at(row)} v${o.version} — already current (content hash matched)`,
      );
      continue;
    }
    lines.push(
      `${verb.padEnd(12)} ${at(row)} v${row.version} → v${o.version} ` +
        `[${o.plan.templateKey}] node "${o.plan.agentNodeId}" gains its outputSchema — ${o.plan.symptom}`,
    );
  }

  for (const f of report.plan.flagged) {
    lines.push(
      `FLAGGED ONLY ${at(f.row)} v${f.row.version} — not an exact fork, NOT modified:`,
    );
    for (const w of f.warnings) lines.push(`               ${w}`);
  }

  const failed = report.outcomes.filter((o) => o.error).length;
  // An UNCHANGED outcome (apply mode, content hash already matched — a re-run) is not a
  // migration, and counting it as one would let the summary contradict the detail lines right
  // above it. In a report whose whole job is "the blast radius is a fact afterwards", the
  // summary saying 1 while the line says UNCHANGED is the wrong way to be wrong.
  const changed = report.outcomes.filter(
    (o) => !o.error && (report.dryRun || o.written),
  ).length;
  lines.push(
    `\n${report.plan.scanned} workflow(s) scanned · ` +
      `${changed} ${report.dryRun ? "would be migrated" : "migrated"} · ` +
      `${report.plan.flagged.length} flagged for the author (never modified) · ` +
      `${failed} failed`,
  );
  if (report.dryRun && changed > 0) {
    lines.push(
      "Nothing was written. Re-run with --apply to write these versions.",
    );
  }
  return lines;
}
