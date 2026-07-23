-- AlterTable
ALTER TABLE "TurnstileConfig" ADD COLUMN "allowedHostnames" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
