-- CreateTable
CREATE TABLE "RoleFeaturePermission" (
    "id" SERIAL NOT NULL,
    "roleId" INTEGER NOT NULL,
    "feature" TEXT NOT NULL,
    "granted" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RoleFeaturePermission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserFeaturePermission" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "feature" TEXT NOT NULL,
    "granted" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserFeaturePermission_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RoleFeaturePermission_feature_idx" ON "RoleFeaturePermission"("feature");

-- CreateIndex
CREATE INDEX "RoleFeaturePermission_roleId_idx" ON "RoleFeaturePermission"("roleId");

-- CreateIndex
CREATE UNIQUE INDEX "RoleFeaturePermission_roleId_feature_key" ON "RoleFeaturePermission"("roleId", "feature");

-- CreateIndex
CREATE INDEX "UserFeaturePermission_feature_idx" ON "UserFeaturePermission"("feature");

-- CreateIndex
CREATE INDEX "UserFeaturePermission_userId_idx" ON "UserFeaturePermission"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "UserFeaturePermission_userId_feature_key" ON "UserFeaturePermission"("userId", "feature");

-- AddForeignKey
ALTER TABLE "RoleFeaturePermission" ADD CONSTRAINT "RoleFeaturePermission_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserFeaturePermission" ADD CONSTRAINT "UserFeaturePermission_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
