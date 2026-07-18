-- Permission groups + six-verb env-scoped workflow grants (RBAC-GROUPS.md §3, slice G1).
-- Purely ADDITIVE and behavior-neutral at deploy (§6): no tenant has grants yet, and a
-- workspace with zero WorkflowGrant rows behaves exactly as before — for members AND API
-- tokens. The FIRST grant an admin creates flips that workspace to deny-by-default.

-- CreateTable
CREATE TABLE "PermissionGroup" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PermissionGroup_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PermissionGroup_tenantId_name_key" ON "PermissionGroup"("tenantId", "name");

-- CreateIndex
CREATE INDEX "PermissionGroup_tenantId_idx" ON "PermissionGroup"("tenantId");

-- CreateTable
CREATE TABLE "GroupMember" (
    "groupId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GroupMember_pkey" PRIMARY KEY ("groupId", "userId")
);

-- CreateIndex
CREATE INDEX "GroupMember_userId_idx" ON "GroupMember"("userId");

-- AddForeignKey
ALTER TABLE "GroupMember" ADD CONSTRAINT "GroupMember_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "PermissionGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable (API tokens as grant subjects, §4a — both FKs Cascade so deleting a token
-- or a group cleans its join rows)
CREATE TABLE "GroupTokenMember" (
    "groupId" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GroupTokenMember_pkey" PRIMARY KEY ("groupId", "tokenId")
);

-- CreateIndex
CREATE INDEX "GroupTokenMember_tokenId_idx" ON "GroupTokenMember"("tokenId");

-- AddForeignKey
ALTER TABLE "GroupTokenMember" ADD CONSTRAINT "GroupTokenMember_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "PermissionGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupTokenMember" ADD CONSTRAINT "GroupTokenMember_tokenId_fkey" FOREIGN KEY ("tokenId") REFERENCES "ApiToken"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable (tenantId is DENORMALIZED on purpose — "does ANY grant exist in this tenant?"
-- is the restriction switch the guard/PermissionsService checks per request; environmentId
-- NULL = every environment, set = that environment only)
CREATE TABLE "WorkflowGrant" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "environmentId" TEXT,
    "scope" TEXT NOT NULL,
    "canView" BOOLEAN NOT NULL DEFAULT false,
    "canRun" BOOLEAN NOT NULL DEFAULT false,
    "canEdit" BOOLEAN NOT NULL DEFAULT false,
    "canDelete" BOOLEAN NOT NULL DEFAULT false,
    "canShare" BOOLEAN NOT NULL DEFAULT false,
    "canCreate" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "WorkflowGrant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WorkflowGrant_tenantId_idx" ON "WorkflowGrant"("tenantId");

-- CreateIndex
CREATE INDEX "WorkflowGrant_groupId_idx" ON "WorkflowGrant"("groupId");

-- AddForeignKey
ALTER TABLE "WorkflowGrant" ADD CONSTRAINT "WorkflowGrant_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "PermissionGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey (Cascade: a grant naming a deleted environment should vanish with it)
ALTER TABLE "WorkflowGrant" ADD CONSTRAINT "WorkflowGrant_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable (key list for scope='selected' grants)
CREATE TABLE "WorkflowGrantKey" (
    "grantId" TEXT NOT NULL,
    "workflowKey" TEXT NOT NULL,

    CONSTRAINT "WorkflowGrantKey_pkey" PRIMARY KEY ("grantId", "workflowKey")
);

-- AddForeignKey
ALTER TABLE "WorkflowGrantKey" ADD CONSTRAINT "WorkflowGrantKey_grantId_fkey" FOREIGN KEY ("grantId") REFERENCES "WorkflowGrant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
