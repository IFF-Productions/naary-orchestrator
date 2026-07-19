-- Tag-scoped grants (RBAC-GROUPS.md §9 seam, shipped): a 'selected'-scope WorkflowGrant may
-- also name TAGS — effective keys = its WorkflowGrantKey list ∪ the workflowKeys carrying any
-- of its tags. ADDITIVE and behavior-neutral at deploy: no tenant has TagGrant rows, and with
-- zero rows tag editing keeps today's edit-gate. The FIRST TagGrant in a workspace makes tags
-- access-bearing there (tag edits become share/promote-gated).

-- CreateTable
CREATE TABLE "TagGrant" (
    "grantId" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TagGrant_pkey" PRIMARY KEY ("grantId", "tagId")
);

-- CreateIndex
CREATE INDEX "TagGrant_tagId_idx" ON "TagGrant"("tagId");

-- AddForeignKey (Cascade both ways: deleting a grant or a tag cleans its rows — a deleted
-- tag simply stops carrying access)
ALTER TABLE "TagGrant" ADD CONSTRAINT "TagGrant_grantId_fkey" FOREIGN KEY ("grantId") REFERENCES "WorkflowGrant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TagGrant" ADD CONSTRAINT "TagGrant_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "Tag"("id") ON DELETE CASCADE ON UPDATE CASCADE;
