/**
 * Worker fleet registry (Queue-mode / Worker view). OPERATOR-only infra telemetry — which worker
 * replicas are connected + their live slot usage — not tenant data. `GET /workers` 403s for
 * non-owner/admin principals (surfaced as an HttpError the screen renders as an access notice).
 */
import { http } from "./http";

/** One worker replica in the fleet (mirrors the API's WorkerResponse). */
export interface WorkerRow {
  /** Stable identity `<host>/<pid>/<version>`. */
  identity: string;
  host: string;
  version: string;
  taskQueue: string;
  /** Activities executing on this replica right now (live slot usage). */
  activeActivities: number;
  /** Configured activity-slot capacity for this replica. */
  maxActivities: number;
  /** Heartbeating within the staleness window (~45s). */
  online: boolean;
  /** ISO timestamp of the last heartbeat. */
  lastSeen: string;
}

export const workersApi = {
  /** The connected worker fleet with live slot usage. Owner/admin only. */
  listWorkers(): Promise<WorkerRow[]> {
    return http("/workers");
  },
};
