import { Injectable } from "@nestjs/common";
import { getPrisma } from "@naary/db";
import type { WorkerResponse } from "./worker.response";

/** A replica is "online" if it heartbeat within this window — 3× the worker's 15s interval, so one
 *  missed beat is tolerated but a crashed/killed replica shows offline within ~45s. */
export const WORKER_STALE_MS = 45_000;

interface HeartbeatRow {
  identity: string;
  host: string;
  version: string;
  taskQueue: string;
  activeActivities: number;
  maxActivities: number;
  lastSeen: Date;
}

/** Map a heartbeat row to the API shape, deriving `online` from the lastSeen age. Pure — testable. */
export function toWorkerResponse(
  row: HeartbeatRow,
  now: number,
): WorkerResponse {
  return {
    identity: row.identity,
    host: row.host,
    version: row.version,
    taskQueue: row.taskQueue,
    activeActivities: row.activeActivities,
    maxActivities: row.maxActivities,
    online: now - row.lastSeen.getTime() < WORKER_STALE_MS,
    lastSeen: row.lastSeen.toISOString(),
  };
}

/** Reads the worker fleet registry (WorkerHeartbeat). Infra-scoped — NOT tenant data. */
@Injectable()
export class WorkersService {
  async list(): Promise<WorkerResponse[]> {
    const rows = await getPrisma().workerHeartbeat.findMany({
      orderBy: { lastSeen: "desc" },
    });
    const now = Date.now();
    return rows.map((r) => toWorkerResponse(r, now));
  }
}
