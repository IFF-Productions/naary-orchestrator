import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from "@nestjs/common";
import { SchedulesService } from "./schedules.service";

/**
 * One-time boot reconcile for the env-scoped-schedules cutover (ENVIRONMENTS.md §7, final
 * slice): migrates Schedule rows still carrying LEGACY (no-env) Temporal ids to the new
 * env-scoped identity — create the new-format Temporal schedule, delete the legacy one, fix
 * the row. Runs once per boot, AFTER every module's onModuleInit (so SchedulesService's
 * Temporal client is connected), fire-and-forget: it MUST NOT block or fail boot on Temporal
 * being down — the sync-time legacy deletes in SchedulesService are the safety net, and the
 * next boot retries. Idempotent: a second run finds no legacy rows and no-ops.
 */
@Injectable()
export class ScheduleReconcileService implements OnApplicationBootstrap {
  private readonly logger = new Logger(ScheduleReconcileService.name);

  constructor(private readonly schedules: SchedulesService) {}

  onApplicationBootstrap(): void {
    // Fire-and-forget — boot must not wait on (or die with) Temporal.
    void this.run();
  }

  /** The reconcile pass; separated from the hook so tests can await it. Never throws. */
  async run(): Promise<void> {
    try {
      const { migrated, failed } =
        await this.schedules.reconcileLegacyScheduleIds();
      if (migrated > 0 || failed > 0) {
        this.logger.log(
          `Legacy schedule-id reconcile: migrated=${migrated} failed=${failed}`,
        );
      }
    } catch (e) {
      this.logger.warn(
        `Legacy schedule-id reconcile skipped (will retry next boot): ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }
}
