-- Enable pgvector (image: pgvector/pgvector:pg16 ships the extension).
CREATE EXTENSION IF NOT EXISTS vector;

-- CreateTable
CREATE TABLE "VectorChunk" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "collection" TEXT NOT NULL,
    "chunkText" TEXT NOT NULL,
    "embedding" vector(1536) NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VectorChunk_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "VectorChunk_tenantId_collection_idx" ON "VectorChunk"("tenantId", "collection");
