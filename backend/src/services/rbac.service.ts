// src/services/rbac.service.ts
import prisma from "../utils/prisma";
import { ApiError } from "../handlers/errorHandler";

/** Helpers to create / get roles */
export async function createRole(payload: { name: string; description?: string | null; isSystem?: boolean }) {
  const existing = await prisma.role.findUnique({ where: { name: payload.name } });
  if (existing) throw new ApiError(400, "Role name already exists");
  return prisma.role.create({ data: payload as any });
}

export async function listRoles() {
  return prisma.role.findMany({ orderBy: { createdAt: "asc" } });
}

export async function getRoleByName(name: string) {
  return prisma.role.findUnique({ where: { name } });
}

/** Get model definition by name */
export async function getModelDefinitionByName(name: string) {
  // Return modelDefinition if exists (system models seeded as well)
  return prisma.modelDefinition.findFirst({ where: { OR: [{ name }, { tableName: name }] } });
}

/**
 * Upsert model-role-permission mapping.
 * permissions: e.g. ["CREATE","READ"] or ["ALL"]
 * This function will create ModelRolePermission rows that reference canonical Permission keys 'MODEL.CREATE', etc.
 *
 * Note: This function *allows* assigning permissions on system models as well. System models are protected
 * with respect to structural changes (model versions/files) but RBAC for them is valid and often necessary.
 */
export async function upsertModelRolePermission(modelId: string, roleId: string, permissions: string[]) {
  // normalize and map to permission keys
  const normalized = permissions.map((p) => String(p).toUpperCase());
  const all = normalized.includes("ALL");

  // fetch model action permission objects
  const permCreate = await prisma.permission.findUnique({ where: { key: "MODEL.CREATE" } });
  const permRead = await prisma.permission.findUnique({ where: { key: "MODEL.READ" } });
  const permUpdate = await prisma.permission.findUnique({ where: { key: "MODEL.UPDATE" } });
  const permDelete = await prisma.permission.findUnique({ where: { key: "MODEL.DELETE" } });

  if (!permCreate || !permRead || !permUpdate || !permDelete) {
    throw new ApiError(500, "Model action permissions not initialized (MODEL.CREATE/READ/UPDATE/DELETE)");
  }

  const toSet: { permissionId: string; allowed: boolean }[] = [];

  if (all) {
    toSet.push({ permissionId: permCreate.id, allowed: true });
    toSet.push({ permissionId: permRead.id, allowed: true });
    toSet.push({ permissionId: permUpdate.id, allowed: true });
    toSet.push({ permissionId: permDelete.id, allowed: true });
  } else {
    if (normalized.includes("CREATE")) toSet.push({ permissionId: permCreate.id, allowed: true });
    if (normalized.includes("READ")) toSet.push({ permissionId: permRead.id, allowed: true });
    if (normalized.includes("UPDATE")) toSet.push({ permissionId: permUpdate.id, allowed: true });
    if (normalized.includes("DELETE")) toSet.push({ permissionId: permDelete.id, allowed: true });
  }

  // Upsert each mapping (ensure old mappings for this model+role that are not in toSet are removed)
  const txOps: any[] = [];

  // remove existing model+role permissions that are not in toSet
  const existing = await prisma.modelRolePermission.findMany({ where: { modelId, roleId } });
  const keepPermissionIds = new Set(toSet.map((t) => t.permissionId));
  const toDelete = existing.filter((e) => !keepPermissionIds.has(e.permissionId));

  for (const del of toDelete) {
    txOps.push(prisma.modelRolePermission.delete({ where: { id: del.id } }));
  }

  // upsert keeps/creates
  for (const t of toSet) {
    txOps.push(
      prisma.modelRolePermission.upsert({
        where: { modelId_roleId_permissionId: { modelId, roleId, permissionId: t.permissionId } },
        update: { allowed: t.allowed },
        create: { modelId, roleId, permissionId: t.permissionId, allowed: t.allowed },
      })
    );
  }

  return prisma.$transaction(txOps);
}

/** Check if role has permission for model action (action: CREATE|READ|UPDATE|DELETE) */
// Priority: modelRolePermission (explicit per-model) -> rolePermission (global role-level) -> false
export async function roleHasPermissionForModel(
  roleId: string,
  modelId: string,
  action: "CREATE" | "READ" | "UPDATE" | "DELETE" | "ALL"
) {
  // Admin role shortcut (if role is Admin) — find role
  const role = await prisma.role.findUnique({ where: { id: roleId } });
  if (!role) return false;
  if (role.name === "Admin") return true;

  // prepare canonical perm ids
  const permKeys = ["MODEL.CREATE", "MODEL.READ", "MODEL.UPDATE", "MODEL.DELETE"];
  const perms = await prisma.permission.findMany({ where: { key: { in: permKeys } } });
  const permMap = new Map(perms.map((p) => [p.key, p.id]));
  // if perm missing, conservative false
  if (permMap.size !== permKeys.length) return false;

  const createId = permMap.get("MODEL.CREATE")!;
  const readId = permMap.get("MODEL.READ")!;
  const updateId = permMap.get("MODEL.UPDATE")!;
  const deleteId = permMap.get("MODEL.DELETE")!;

  if (action === "ALL") {
    // If any modelRolePermission grants an allowed true -> true
    const modelPerms = await prisma.modelRolePermission.findMany({
      where: { roleId, modelId, allowed: true },
    });
    if (modelPerms.length > 0) return true;

    // fallback to global rolePermission
    const rolePerms = await prisma.rolePermission.findMany({ where: { roleId, permissionId: { in: [createId, readId, updateId, deleteId] }, granted: true } });
    return rolePerms.length > 0;
  }

  const key = `MODEL.${action}`;
  const permissionId = permMap.get(key);
  if (!permissionId) return false;

  // 1. model-level explicit
  const mr = await prisma.modelRolePermission.findUnique({
    where: { modelId_roleId_permissionId: { modelId, roleId, permissionId } },
  });
  if (mr) return !!mr.allowed;

  // 2. fallback to rolePermission (global feature-level)
  const rp = await prisma.rolePermission.findUnique({ where: { roleId_permissionId: { roleId, permissionId } } });
  if (rp) return !!rp.granted;

  // else false
  return false;
}

/**
 * Returns merged per-model permissions for a user.
 * shape: [{ model: 'Product', CREATE: true, READ: true, UPDATE: false, DELETE: false }, ...]
 *
 * includeUnpublished: if true, include all models (admin use); otherwise include published models plus system models.
 */
export async function getMergedModelPermissionsForUser(userId: string, includeUnpublished = false) {
  // 1) validate user
  const user = await prisma.user.findUnique({ where: { id: userId }, include: { role: true } });
  if (!user) throw new ApiError(404, "User not found");

  // Admin shortcut: return all (published or all) with true
  if (user.role?.name === "Admin") {
    const models = await prisma.modelDefinition.findMany({
      where: includeUnpublished ? {} : { OR: [{ published: true }, { isSystem: true }] },
      select: { name: true },
      orderBy: { name: "asc" },
    });
    return models.map((m) => ({ model: m.name, CREATE: true, READ: true, UPDATE: true, DELETE: true }));
  }

  // 2) find canonical model action permissions
  const permKeys = ["MODEL.CREATE", "MODEL.READ", "MODEL.UPDATE", "MODEL.DELETE"];
  const perms = await prisma.permission.findMany({ where: { key: { in: permKeys } } });
  const permMap = new Map(perms.map((p) => [p.key, p.id]));
  // ensure all model-action permissions exist
  const missing = permKeys.filter((k) => !permMap.has(k));
  if (missing.length) {
    throw new ApiError(500, `Model action permissions missing: ${missing.join(", ")}`);
  }
  const createId = permMap.get("MODEL.CREATE") as string;
  const readId = permMap.get("MODEL.READ") as string;
  const updateId = permMap.get("MODEL.UPDATE") as string;
  const deleteId = permMap.get("MODEL.DELETE") as string;

  // 3) fetch models (published by default but always include system models)
  const whereClause: any = includeUnpublished ? {} : { OR: [{ published: true }, { isSystem: true }] };
  const models = await prisma.modelDefinition.findMany({
    where: whereClause,
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });
  const modelIds = models.map((m) => m.id);

  // 4) fetch user-level overrides for model-action perms (userPermission)
  const userPermRows = await prisma.userPermission.findMany({
    where: { userId, permissionId: { in: [createId, readId, updateId, deleteId] } },
    include: { permission: true },
  });
  // Map: permissionKey -> granted
  const userPermMap = new Map<string, boolean>();
  userPermRows.forEach((up) => userPermMap.set(up.permission.key, !!up.granted));

  // 5) fetch role-level global permissions (rolePermission) if user has role
  const rolePermMap = new Map<string, boolean>();
  if (user.roleId) {
    const rrows = await prisma.rolePermission.findMany({
      where: { roleId: user.roleId, permissionId: { in: [createId, readId, updateId, deleteId] } },
      include: { permission: true },
    });
    rrows.forEach((rr) => rolePermMap.set(rr.permission.key, !!rr.granted));
  }

  // 6) fetch modelRolePermission rows for this user's role for the models (if user has role)
  const modelRoleMap = new Map<string, Map<string, boolean>>();
  if (user.roleId && modelIds.length > 0) {
    const mrows = await prisma.modelRolePermission.findMany({
      where: { modelId: { in: modelIds }, roleId: user.roleId, permissionId: { in: [createId, readId, updateId, deleteId] } },
      include: { permission: true },
    });
    for (const mr of mrows) {
      const mm = modelRoleMap.get(mr.modelId) ?? new Map<string, boolean>();
      mm.set(mr.permission.key, !!mr.allowed);
      modelRoleMap.set(mr.modelId, mm);
    }
  }

  // 7) Build merged result per model using priority:
  //   userPermission -> modelRolePermission -> rolePermission -> false
  const results = models.map((m) => {
    const perModelMap = modelRoleMap.get(m.id) ?? new Map<string, boolean>();

    const create =
      userPermMap.has("MODEL.CREATE")
        ? userPermMap.get("MODEL.CREATE")!
        : perModelMap.has("MODEL.CREATE")
        ? perModelMap.get("MODEL.CREATE")!
        : rolePermMap.get("MODEL.CREATE") ?? false;

    const read =
      userPermMap.has("MODEL.READ")
        ? userPermMap.get("MODEL.READ")!
        : perModelMap.has("MODEL.READ")
        ? perModelMap.get("MODEL.READ")!
        : rolePermMap.get("MODEL.READ") ?? false;

    const update =
      userPermMap.has("MODEL.UPDATE")
        ? userPermMap.get("MODEL.UPDATE")!
        : perModelMap.has("MODEL.UPDATE")
        ? perModelMap.get("MODEL.UPDATE")!
        : rolePermMap.get("MODEL.UPDATE") ?? false;

    const del =
      userPermMap.has("MODEL.DELETE")
        ? userPermMap.get("MODEL.DELETE")!
        : perModelMap.has("MODEL.DELETE")
        ? perModelMap.get("MODEL.DELETE")!
        : rolePermMap.get("MODEL.DELETE") ?? false;

    return {
      model: m.name,
      CREATE: !!create,
      READ: !!read,
      UPDATE: !!update,
      DELETE: !!del,
    };
  });

  return results;
}
