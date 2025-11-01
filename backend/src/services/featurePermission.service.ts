// src/services/featurePermission.service.ts
import prisma from "../utils/prisma";
import { ApiError } from "../handlers/errorHandler";

/** Create or ensure a permission row exists for a key */
export async function ensurePermission(key: string, name?: string, category = "feature") {
  const normalized = key.toUpperCase();
  return prisma.permission.upsert({
    where: { key: normalized },
    update: { name: name ?? key, category },
    create: { key: normalized, name: name ?? key, category },
  });
}

/** Grant or revoke role-level permission using permission key */
export async function upsertRolePermission(roleName: string, permissionKey: string, granted = true) {
  const role = await prisma.role.findUnique({ where: { name: roleName } });
  if (!role) throw new ApiError(404, "Role not found");

  const perm = await prisma.permission.findUnique({ where: { key: permissionKey.toUpperCase() } });
  if (!perm) throw new ApiError(404, "Permission key not found");

  if (!granted) {
    await prisma.rolePermission.deleteMany({
      where: { roleId: role.id, permissionId: perm.id },
    });
    return { deleted: true };
  }

  return prisma.rolePermission.upsert({
    where: { roleId_permissionId: { roleId: role.id, permissionId: perm.id } },
    update: { granted: true },
    create: { roleId: role.id, permissionId: perm.id, granted: true },
  });
}

export async function upsertUserPermission(userId: string, permissionKey: string, granted = true) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { role: { include: { rolePermissions: { include: { permission: true } } } } },
  });
  if (!user) throw new ApiError(404, "User not found");

  const perm = await prisma.permission.findUnique({ where: { key: permissionKey.toUpperCase() } });
  if (!perm) throw new ApiError(404, "Permission key not found");

  // Step 1: Check if user's role already grants this permission
  const roleAlreadyGrants = user.role?.rolePermissions.some(
    (rp) => rp.permission.key === permissionKey.toUpperCase() && rp.granted
  );

  // Step 2: If role already grants and user tries to grant again — skip creation
  if (roleAlreadyGrants && granted) {
    return { message: `Permission '${permissionKey}' already granted via role '${user.role?.name}'` };
  }

  // Step 3: If user tries to revoke something granted via role — block or allow depending on policy
  if (roleAlreadyGrants && !granted) {
    throw new ApiError(400, `Cannot revoke permission '${permissionKey}' because it is granted via role '${user.role?.name}'`);
  }

  // Step 4: Proceed with user-level upsert
  if (!granted) {
    await prisma.userPermission.deleteMany({ where: { userId, permissionId: perm.id } });
    return { deleted: true };
  }

  return prisma.userPermission.upsert({
    where: { userId_permissionId: { userId, permissionId: perm.id } },
    update: { granted: true },
    create: { userId, permissionId: perm.id, granted: true },
  });
}


/** list role permissions (expanded) */
export async function listRolePermissions(roleName: string) {
  const role = await prisma.role.findUnique({ where: { name: roleName } });
  if (!role) throw new ApiError(404, "Role not found");
  return prisma.rolePermission.findMany({ where: { roleId: role.id }, include: { permission: true } });
}

/** list user permissions */
export async function listUserPermissions(userId: string) {
  return prisma.userPermission.findMany({ where: { userId }, include: { permission: true } });
}

/**
 * checkFeatureAllowed(userId, permissionKey)
 * Priority:
 * 1) Admin role shortcut -> allow.
 * 2) userPermission override -> obey.
 * 3) rolePermission -> obey.
 * 4) deny.
 */
export async function checkFeatureAllowed(userId: string, permissionKey: string) {
  const normalized = permissionKey.toUpperCase();
  const user = await prisma.user.findUnique({ where: { id: userId }, include: { role: true } });
  if (!user) throw new ApiError(404, "User not found");

  if (user.role?.name === "Admin") return true;

  const perm = await prisma.permission.findUnique({ where: { key: normalized } });
  if (!perm) return false;

  const uPerm = await prisma.userPermission.findUnique({ where: { userId_permissionId: { userId: user.id, permissionId: perm.id } } });
  if (uPerm) return !!uPerm.granted;

  if (user.role) {
    const rPerm = await prisma.rolePermission.findUnique({ where: { roleId_permissionId: { roleId: user.role.id, permissionId: perm.id } } });
    if (rPerm) return !!rPerm.granted;
  }

  return false;
}

export async function getMergedPermissionsForUser(userId: string) {
  // 1. Find user and their role
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, roleId: true },
  });

  if (!user) throw new Error("User not found");

  // 2. Fetch all role permissions (if any)
  let rolePerms: { key: string; granted: boolean }[] = [];
  if (user.roleId) {
    rolePerms = await prisma.rolePermission.findMany({
      where: { roleId: user.roleId },
      include: { permission: { select: { key: true } } },
    }).then((rows) =>
      rows.map((r) => ({
        key: r.permission.key,
        granted: r.granted,
      }))
    );
  }

  // 3. Fetch user-specific overrides
  const userPerms = await prisma.userPermission
    .findMany({
      where: { userId: user.id },
      include: { permission: { select: { key: true } } },
    })
    .then((rows) =>
      rows.map((r) => ({
        key: r.permission.key,
        granted: r.granted,
      }))
    );

  // 4. Merge permissions (user overrides role)
  const mergedMap = new Map<string, boolean>();

  // Start with role perms
  for (const r of rolePerms) {
    mergedMap.set(r.key, r.granted);
  }

  // Apply user overrides
  for (const u of userPerms) {
    mergedMap.set(u.key, u.granted);
  }

  // 5. Build final array
  const mergedPermissions = Array.from(mergedMap.entries()).map(([key, granted]) => ({
    key,
    granted,
  }));

  return mergedPermissions;
}