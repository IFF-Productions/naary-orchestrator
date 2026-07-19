-- Company-wide permission groups (RBAC-GROUPS §9 / COMPANIES §9): a SECOND grant source
-- unioned into workspace permission resolution. ADDITIVE and behavior-neutral at deploy:
-- no company has groups yet, and company grants only ever ADD access back for subjects a
-- workspace has ALREADY restricted via its own first-grant cliff — they never flip a
-- workspace's cliff, and an unenforced workspace is completely unaffected.
--
-- v1 bounds (deliberate): CompanyWorkflowGrant has NO scope/keys/environmentId columns —
-- company grants are 'all'-scope + all-environments only, because per-key/per-env
-- selections are workspace-local names that don't compose across workspaces. uid-keyed
-- members only — API tokens are workspace-scoped subjects and never receive company grants.

-- CreateTable
CREATE TABLE "CompanyPermissionGroup" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CompanyPermissionGroup_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CompanyPermissionGroup_companyId_name_key" ON "CompanyPermissionGroup"("companyId", "name");

-- CreateIndex
CREATE INDEX "CompanyPermissionGroup_companyId_idx" ON "CompanyPermissionGroup"("companyId");

-- AddForeignKey (Cascade: deleting a company removes its groups with members + grants)
ALTER TABLE "CompanyPermissionGroup" ADD CONSTRAINT "CompanyPermissionGroup_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "CompanyGroupMember" (
    "groupId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CompanyGroupMember_pkey" PRIMARY KEY ("groupId", "userId")
);

-- CreateIndex
CREATE INDEX "CompanyGroupMember_userId_idx" ON "CompanyGroupMember"("userId");

-- AddForeignKey
ALTER TABLE "CompanyGroupMember" ADD CONSTRAINT "CompanyGroupMember_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "CompanyPermissionGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable (six verbs only — see the v1 bounds note above)
CREATE TABLE "CompanyWorkflowGrant" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "canView" BOOLEAN NOT NULL DEFAULT false,
    "canRun" BOOLEAN NOT NULL DEFAULT false,
    "canEdit" BOOLEAN NOT NULL DEFAULT false,
    "canDelete" BOOLEAN NOT NULL DEFAULT false,
    "canShare" BOOLEAN NOT NULL DEFAULT false,
    "canCreate" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CompanyWorkflowGrant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CompanyWorkflowGrant_groupId_idx" ON "CompanyWorkflowGrant"("groupId");

-- AddForeignKey
ALTER TABLE "CompanyWorkflowGrant" ADD CONSTRAINT "CompanyWorkflowGrant_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "CompanyPermissionGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;
