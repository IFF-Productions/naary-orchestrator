-- Self-healing workflows, Phase 2 (docs/design plan: healRun + approval gate).
--
-- Expand/contract safe: two entirely NEW tables. An older API/worker image ignores both, and a
-- rollback loses only proposals generated in the window — nothing they touched is written to a
-- workflow without an approval, which is a separate, explicit step.

-- Per-workflow opt-in. ABSENCE ⇒ OFF, the opposite default to "WorkflowActivation": an automatic
-- edit to someone's production workflow — even a proposed one that spends BYOK tokens to
-- generate — is not something to switch on for people.
CREATE TABLE "SelfHealSetting" (
    "tenantId" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "workflowKey" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SelfHealSetting_pkey" PRIMARY KEY ("tenantId","environmentId","workflowKey")
);

-- Cascade, not Restrict: a binding is disposable config, so deleting an environment removes it
-- rather than 409-blocking the delete (same rationale as ErrorHandler / pins / channels).
ALTER TABLE "SelfHealSetting"
  ADD CONSTRAINT "SelfHealSetting_environmentId_fkey"
  FOREIGN KEY ("environmentId") REFERENCES "Environment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A proposed fix awaiting a human decision.
CREATE TABLE "WorkflowFixProposal" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "workflowKey" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "failureSignature" TEXT NOT NULL,
    "failureSummary" TEXT NOT NULL,
    "baseVersion" INTEGER NOT NULL,
    "proposedGraph" JSONB NOT NULL,
    "diffSummary" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "appliedVersion" INTEGER,
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkflowFixProposal_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "WorkflowFixProposal"
  ADD CONSTRAINT "WorkflowFixProposal_environmentId_fkey"
  FOREIGN KEY ("environmentId") REFERENCES "Environment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- THE DEDUPE GUARANTEE, in the database rather than in a read-then-write race.
--
-- A workflow failing on a 5-minute schedule produces a failed run every 5 minutes, each of which
-- would otherwise generate a proposal and bill the tenant for the model call. At most ONE pending
-- proposal per distinct failure; a genuinely different failure gets its own row.
--
-- PARTIAL on `status = 'pending'` — decided proposals must not block a later, identical failure
-- from being proposed again, which is the whole point of having rejected one.
CREATE UNIQUE INDEX "WorkflowFixProposal_pending_signature_key"
  ON "WorkflowFixProposal" ("tenantId", "environmentId", "workflowKey", "failureSignature")
  WHERE "status" = 'pending';

-- The inbox ("what is waiting for me") and the per-workflow list.
CREATE INDEX "WorkflowFixProposal_tenantId_environmentId_workflowKey_status_idx"
  ON "WorkflowFixProposal" ("tenantId", "environmentId", "workflowKey", "status");
CREATE INDEX "WorkflowFixProposal_tenantId_status_idx"
  ON "WorkflowFixProposal" ("tenantId", "status");
-- "Was a fix proposed for this run?" — the run-detail banner.
CREATE INDEX "WorkflowFixProposal_runId_idx" ON "WorkflowFixProposal" ("runId");
