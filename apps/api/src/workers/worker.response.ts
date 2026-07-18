import { ApiProperty } from "@nestjs/swagger";

/** One worker replica in the fleet (Queue-mode / Worker view). Infra telemetry — no tenant data. */
export class WorkerResponse {
  @ApiProperty({
    example: "worker-7f3a/12/v0.0.10",
    description: "Stable identity `<host>/<pid>/<version>`.",
  })
  identity!: string;
  @ApiProperty({ example: "worker-7f3a" })
  host!: string;
  @ApiProperty({ example: "v0.0.10" })
  version!: string;
  @ApiProperty({ example: "orchestrator" })
  taskQueue!: string;
  @ApiProperty({
    example: 3,
    description:
      "Activities executing on this replica right now (live slot usage).",
  })
  activeActivities!: number;
  @ApiProperty({
    example: 100,
    description: "Configured activity-slot capacity for this replica.",
  })
  maxActivities!: number;
  @ApiProperty({
    example: true,
    description:
      "Whether the replica is heartbeating (last seen within the staleness window).",
  })
  online!: boolean;
  @ApiProperty({ format: "date-time", example: "2026-08-02T12:00:00.000Z" })
  lastSeen!: string;
}
