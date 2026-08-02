-- GroupMember → Membership: make "must hold a Membership in the group's tenant" a REAL constraint (#1041).
--
-- THE BUG THIS CLOSES. `MembersService.removeMember` deleted the Membership and left the user's
-- `GroupMember` rows behind. Nothing cascaded, because `GroupMember.userId` was a bare string whose
-- only stated constraint was a code comment. Consequence: remove a user, re-invite them later, and
-- they silently regain every permission group they used to be in — nobody grants it, nothing
-- surfaces it, and the re-adding admin has no reason to look. (`GroupTokenMember` next door already
-- cascades on both FKs; `GroupMember` was the odd one out precisely because of that bare string.)
--
-- WHY A DENORMALIZED tenantId. A foreign key cannot reach through a join. The tenant lives on
-- `PermissionGroup`, and `Membership`'s only unique key is (userId, tenantId) — so the reference
-- needs BOTH columns on this row. `WorkflowGrant.tenantId` is denormalized for the same class of
-- reason. It is kept honest by the group FK plus the writers, which copy it from the group they
-- are writing to.
--
-- ============================ EXPAND / CONTRACT ============================
-- This repo deploys by running `migrate` to completion and THEN rolling-replacing api/worker
-- (deploy/README.md), so the OLD image runs against this schema. The old image inserts
-- `GroupMember (groupId, userId)` with no tenantId — a NOT NULL column would 500 every
-- group-membership write for the length of the rollout. So:
--
--   EXPAND (this migration):  add "tenantId" NULLABLE, backfill it, add the FK.
--                             Under Postgres MATCH SIMPLE a row with a NULL "tenantId" is EXEMPT
--                             from the composite FK, which is what makes the nullable phase safe —
--                             and also means the constraint has a HOLE for rows the old image
--                             writes during the rollout window. `MembersService.removeMember`
--                             therefore ALSO deletes these rows transactionally: that is the bridge
--                             across the window, and it stays afterwards as defense in depth.
--   CONTRACT (a later release, tracked separately): backfill any remaining NULL "tenantId" from the
--                             group, then `ALTER TABLE "GroupMember" ALTER COLUMN "tenantId" SET NOT
--                             NULL`. Only safe once no old image can still be writing.
--
-- ============================ EFFECT ON A REAL DATABASE ============================
-- Step 1 DELETES pre-existing orphans, because a constraint cannot be added over data that
-- violates it. What it removes is exactly the set of rows that would have silently re-armed on
-- re-invite. It cannot remove a row belonging to a present member:
--   * `GroupsService.addMember` 400s unless the target already holds a Membership;
--   * accept-on-login (`MembershipService.acceptPendingInvitations`) upserts the Membership FIRST
--     and only then creates the GroupMember rows — so an invited-with-groupIds user who has not
--     logged in yet owns no GroupMember rows to lose.
-- An operator can size the blast radius before applying with the SELECT in the PR body.
-- Locking: `ADD CONSTRAINT` takes ACCESS EXCLUSIVE on GroupMember and SHARE ROW EXCLUSIVE on
-- Membership while it validates. Both are small (one row per user per group), so this is brief.

-- 1. Remove the orphans (rows whose user holds no Membership in the group's tenant). These are
--    inert today — AuthGuard fails closed without a Membership — and dangerous only on re-invite.
DELETE FROM "GroupMember" gm
USING "PermissionGroup" pg
WHERE gm."groupId" = pg."id"
  AND NOT EXISTS (
    SELECT 1 FROM "Membership" m
    WHERE m."userId" = gm."userId" AND m."tenantId" = pg."tenantId"
  );

-- 2. Expand: NULLABLE on purpose (see EXPAND/CONTRACT above).
ALTER TABLE "GroupMember" ADD COLUMN "tenantId" TEXT;

-- 3. Backfill from the owning group. Every surviving row gets a value here; only rows the OLD
--    image writes during the rollout can still be NULL.
UPDATE "GroupMember" gm
SET "tenantId" = pg."tenantId"
FROM "PermissionGroup" pg
WHERE gm."groupId" = pg."id";

-- 4. Serves the FK's referencing side and the tenant-scoped cleanup delete.
CREATE INDEX "GroupMember_userId_tenantId_idx" ON "GroupMember"("userId", "tenantId");

-- 5. The constraint itself. References Membership's (userId, tenantId) unique index. CASCADE: a
--    membership deleted by ANY path — the members API, a future SCIM de-provision (#1040), a
--    workspace teardown — takes that user's group rows in that workspace with it.
ALTER TABLE "GroupMember" ADD CONSTRAINT "GroupMember_userId_tenantId_fkey"
  FOREIGN KEY ("userId", "tenantId") REFERENCES "Membership"("userId", "tenantId")
  ON DELETE CASCADE ON UPDATE CASCADE;
