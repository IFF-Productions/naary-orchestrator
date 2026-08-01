-- Workflow key rename (#904). A workflow's `key` used to be derived from its name and frozen at the
-- first save: a typo or an "untitled-workflow" was permanent, because `workflowKey` is a
-- DENORMALIZED string in ~18 tables with no foreign key, so nothing cascades.
--
-- The rename REWRITES every row we own to the new key and records the OLD key here. This table is
-- the compatibility layer for the references we cannot rewrite: `executeSubWorkflow`/`forEach`
-- workflowKeys inside OTHER graphs' node configs, MCP tool names in external agent configs, the args
-- of in-flight Temporal runs and already-armed schedule handles, and public-API / CLI / bookmark
-- callers. Rewrite what we own; alias what we don't.
--
-- TENANT-WIDE (no environmentId): a workflowKey is one logical identity that copy-on-promote
-- replicates per environment — Promotion and WorkflowTag are tenant-wide for exactly this reason —
-- so a rename moves every environment's copy at once and one alias row covers them all.
--
-- EXPAND/CONTRACT SAFE: a brand-new, standalone table with no FK and no change to any existing
-- column, so the OLD API/worker images running alongside during a docker-rollout deploy simply never
-- read or write it and are entirely unaffected by its presence. Nothing to contract later.
-- (The rollout caveat is behavioural, not schema-level: an old image has no alias awareness, so
-- until every container is on the new image a request addressed by a RETIRED key can still 404. A
-- rename can only be issued by a new image in the first place, so the window is bounded by the
-- rollout and degrades availability of a retired key — it never corrupts data.)
--
-- The PK is the uniqueness guarantee: two workflows can never claim the same alias, and a retired
-- alias can never be registered twice. "An alias must not collide with a LIVE key" cannot be
-- expressed as a constraint — GraphDefinition is VERSIONED, so it has no unique on
-- (tenantId, workflowKey) to reference — and is asserted inside the rename transaction instead.
CREATE TABLE "WorkflowKeyAlias" (
    "tenantId" TEXT NOT NULL,
    "alias" TEXT NOT NULL,
    "workflowKey" TEXT NOT NULL,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkflowKeyAlias_pkey" PRIMARY KEY ("tenantId","alias")
);

-- Serves the rename's "re-point every alias that already targets me" update (aliases stay ONE HOP
-- after a second rename) and the delete-workflow cleanup that frees a deleted workflow's keys.
CREATE INDEX "WorkflowKeyAlias_tenantId_workflowKey_idx" ON "WorkflowKeyAlias"("tenantId", "workflowKey");
