-- Invitations (RBAC-GROUPS.md §3/§5, slice U1). A pending row is converted to a Membership
-- by the AuthGuard's accept-on-login when a VERIFIED Firebase email matches `email`
-- (case-insensitively; app writes emails lowercased). acceptedAt null = pending.

-- CreateTable
CREATE TABLE "Invitation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'member',
    "groupIds" JSONB,
    "invitedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acceptedAt" TIMESTAMP(3),

    CONSTRAINT "Invitation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Invitation_tenantId_email_key" ON "Invitation"("tenantId", "email");

-- CreateIndex
CREATE INDEX "Invitation_email_idx" ON "Invitation"("email");

-- One-time seed (RBAC-GROUPS.md §5): the legacy advisory `Member` directory becomes pending
-- Invitations — but ONLY where no Membership already covers that (tenantId, email). Where a
-- Membership exists its role WINS: advisory Member roles are never auto-promoted onto real
-- memberships (that would be a silent escalation). Emails are lowercased to match the
-- accept-on-login normalization; `invitedBy = 'member-seed'` marks migrated rows. The
-- `Member` table itself is retired in slice G3 — not dropped here.
INSERT INTO "Invitation" ("id", "tenantId", "email", "role", "invitedBy", "createdAt")
SELECT gen_random_uuid()::text, m."tenantId", lower(m."email"), m."role", 'member-seed', m."createdAt"
FROM "Member" m
WHERE NOT EXISTS (
    SELECT 1 FROM "Membership" ms
    WHERE ms."tenantId" = m."tenantId"
      AND ms."email" IS NOT NULL
      AND lower(ms."email") = lower(m."email")
)
ON CONFLICT ("tenantId", "email") DO NOTHING;
