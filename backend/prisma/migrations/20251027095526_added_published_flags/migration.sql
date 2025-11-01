-- AlterTable
ALTER TABLE "ModelDefinition" ADD COLUMN     "filePath" TEXT,
ADD COLUMN     "published" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "publishedAt" TIMESTAMP(3),
ADD COLUMN     "publishedById" TEXT;
