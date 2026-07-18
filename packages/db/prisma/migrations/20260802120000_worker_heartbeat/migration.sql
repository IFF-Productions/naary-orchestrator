-- Queue-mode fleet registry (QUEUE-MODE.md §3.2): one heartbeat row per worker replica, keyed on its
-- identity `<host>/<pid>/<version>`, carrying live slot usage. Additive (expand-safe): no FK, no code
-- read it until GET /workers ships in the same slice; the worker upserts it best-effort.
CREATE TABLE "WorkerHeartbeat" (
    "identity" TEXT NOT NULL,
    "taskQueue" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "activeActivities" INTEGER NOT NULL DEFAULT 0,
    "maxActivities" INTEGER NOT NULL,
    "lastSeen" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkerHeartbeat_pkey" PRIMARY KEY ("identity")
);

CREATE INDEX "WorkerHeartbeat_lastSeen_idx" ON "WorkerHeartbeat"("lastSeen");
