-- AlterTable
ALTER TABLE "Execution" ADD COLUMN     "costUsd" DECIMAL(12,6),
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'running';
