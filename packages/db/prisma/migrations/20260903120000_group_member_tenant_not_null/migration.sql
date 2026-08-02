-- GroupMember."tenantId" → NOT NULL: the CONTRACT half of the expand/contract pair (#1052).
--
-- WHAT THE EXPAND PHASE LEFT OPEN. `20260902120000_group_member_membership_fk` (#1041) added
-- "tenantId" NULLABLE plus the composite FK
--   GroupMember(userId, tenantId) → Membership(userId, tenantId) ON DELETE CASCADE
-- and backfilled every pre-existing row. Nullable was mandatory: this repo runs `migrate` to
-- completion and THEN rolls the images (deploy/README.md), so the OLD image runs against the new
-- schema and inserts `GroupMember (groupId, userId)` with no tenantId — NOT NULL would have 500'd
-- every group-membership write for the length of that rollout.
--
-- Under Postgres MATCH SIMPLE a row with a NULL "tenantId" is EXEMPT from that composite FK. That
-- exemption is exactly what made the nullable phase safe, and it is exactly the hole: a row an OLD
-- image wrote during the rollout window is not covered, so a later `Membership` delete does NOT
-- cascade it — the silent privilege-restoration bug of #1041, still live for that one row class.
-- (`GroupsService.addMember` writes tenantId in both `create` and `update`, so such a row heals the
-- next time anyone re-adds that member. This migration is about not depending on that.)
--
-- PRECONDITION. Safe only once no old image can still be writing: #1041 shipped in v0.0.66 and
-- v0.0.66 is deployed, so every running image sets "tenantId". Landing this in the same release as
-- the expand step would have reintroduced the 500 the nullable column avoided.
--
-- ============================ WHY THE ORDER IS DELETE → UPDATE → SET NOT NULL ============================
-- The FK already exists. While "tenantId" is NULL the row is exempt; the instant the backfill sets
-- it, both referencing columns are non-NULL and Postgres CHECKS the constraint. So a NULL row whose
-- user no longer holds a Membership in the group's tenant makes the UPDATE itself fail with 23503
-- and aborts the migration. That row class is reachable, not theoretical: the old image creates the
-- NULL row, then the membership is deleted by a path that neither cascades (NULL ⇒ FK-exempt) nor
-- runs the new transactional cleanup (the old image's `removeMember`). Hence the orphan DELETE runs
-- FIRST. Doing it the other way round is a migration that fails on production data.
--
-- WHY THE DELETE IS SCOPED TO "tenantId" IS NULL. Non-NULL rows were validated by the FK on write,
-- so none of them can be an orphan — the scope removes nothing the unscoped form would legitimately
-- remove. It does, however, keep this migration off rows it has no business touching: the orphan
-- predicate tests membership in the GROUP's tenant (pg."tenantId"), while the FK validated the ROW's
-- tenant (gm."tenantId"), and nothing in the database forces those two to be equal. Scoped to NULL,
-- the contract step provably touches only the rollout-window rows it exists for.
--
-- A ROW WHOSE GROUP NO LONGER EXISTS cannot exist: "GroupMember_groupId_fkey" is ON DELETE CASCADE,
-- so a row cannot outlive its PermissionGroup. If one somehow did, it would have no tenant to be
-- backfilled from, the UPDATE would skip it, and step 3 would FAIL LOUDLY — which is the correct
-- outcome. A row we cannot attribute to a tenant is not something a migration should delete
-- silently; an operator should look at it.
--
-- BLAST RADIUS. The operator pre-flight SELECT (in the PR body) counts the NULL rows and splits
-- them into healable vs deleted before anything is applied. Expected in practice: zero — the window
-- was one rollout long and `addMember`'s `update: { tenantId }` heals a survivor on any re-add.
-- Locking: both statements touch only rows with a NULL tenantId; `SET NOT NULL` takes ACCESS
-- EXCLUSIVE on "GroupMember" for one full scan. The table is small (one row per user per group).

-- 1. Drop rollout-window rows whose user holds no Membership in the group's tenant. These are the
--    rows the FK could never have accepted; they are inert while the user is gone (AuthGuard fails
--    closed without a Membership) and dangerous only on re-invite. Must precede step 2 — see above.
DELETE FROM "GroupMember" gm
USING "PermissionGroup" pg
WHERE gm."groupId" = pg."id"
  AND gm."tenantId" IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM "Membership" m
    WHERE m."userId" = gm."userId" AND m."tenantId" = pg."tenantId"
  );

-- 2. Heal the survivors from the owning group — the same value every writer sets. Each row healed
--    here becomes FK-covered at this instant, which is the point of the whole exercise.
UPDATE "GroupMember" gm
SET "tenantId" = pg."tenantId"
FROM "PermissionGroup" pg
WHERE gm."groupId" = pg."id"
  AND gm."tenantId" IS NULL;

-- 3. Close the hole. No row can be FK-exempt any more: MATCH SIMPLE's NULL escape is gone, so the
--    "a group member must hold a Membership in the group's tenant" invariant is now enforced by the
--    database on EVERY path — the members API, SCIM de-provisioning (#1040), a workspace teardown.
--    Fails loudly if any NULL survives, which is the desired behaviour, not a case to work around.
ALTER TABLE "GroupMember" ALTER COLUMN "tenantId" SET NOT NULL;
