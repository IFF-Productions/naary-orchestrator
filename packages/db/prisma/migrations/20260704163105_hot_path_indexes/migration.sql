-- DropIndex
DROP INDEX "Execution_tenantId_idx";

-- CreateIndex
CREATE INDEX "Execution_tenantId_createdAt_idx" ON "Execution"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "WebhookDelivery_endpointId_createdAt_idx" ON "WebhookDelivery"("endpointId", "createdAt");
