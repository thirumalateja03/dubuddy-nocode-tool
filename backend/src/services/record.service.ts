// src/services/record.service.ts
import bcrypt from "bcryptjs";
import { ApiError } from "../handlers/errorHandler";
import prisma from "../utils/prisma";

/**
 * Record service
 * - Dual-write for system models (User, Role): write to prisma.user/prisma.role first, then to record table
 * - For non-system models: normal record-only behavior
 *
 * Note: keep types flexible (any) because model.json shapes are dynamic.
 */

/* -------------------------- Config ---------------------------------- */
const HASH_ROUNDS = Number(process.env.HASH_ROUNDS ?? 12);

/* -------------------------- Utilities -------------------------------- */
function extractDefinitionFromJson(json: any): any {
  if (!json || typeof json !== "object" || Array.isArray(json)) return {};
  return (json.definition ?? json) as Record<string, any>;
}
function fieldsFromDefinition(json: any): any[] {
  const def = extractDefinitionFromJson(json);
  return Array.isArray(def.fields) ? def.fields : [];
}
function normalizeId(v: any): string {
  if (v === null || v === undefined) return "";
  return String(v);
}
function canonicalRelationType(rel: any): string {
  if (!rel) return "";
  const t = String(rel.type ?? rel.kind ?? "").toLowerCase();
  if (["one-to-one", "one2one", "onetoon e"].includes(t)) return "one-to-one";
  if (["one-to-many", "one_to_many", "hasmany", "hasMany"].map(String).includes(t)) return "one-to-many";
  if (["many-to-one", "many_to_one", "belongsto", "belongsto"].map(String).includes(t)) return "many-to-one";
  if (["many-to-many", "many_to_many", "manytomany"].map(String).includes(t)) return "many-to-many";
  return t;
}

/* ----------------------- Json helpers -------------------------------- */
/** Narrow a Json value into a plain object for safe spreading */
function asRecordObject(v: any): Record<string, any> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, any>) : {};
}

/**
 * Try to extract origin/system id from a record's data.
 * It looks for data.id or data._origin?.id.
 */
function originIdFromRecordData(data: any): string | null {
  if (!data || typeof data !== "object") return null;
  if (data.id && typeof data.id === "string") return data.id;
  if (data._origin && typeof data._origin === "object" && data._origin.id && typeof data._origin.id === "string")
    return data._origin.id;
  return null;
}

/* ------------------------ Model resolution ---------------------------- */
export async function resolvePublishedModel(routeName: string) {
  if (!routeName) throw new ApiError(400, "modelName required");

  const model = await prisma.modelDefinition.findFirst({
    where: {
      OR: [
        { name: { equals: routeName, mode: "insensitive" } },
        { tableName: { equals: routeName, mode: "insensitive" } },
        { name: routeName },
        { tableName: routeName },
      ],
    },
  });

  if (!model) throw new ApiError(404, `Model not found: ${routeName}`);
  if (!model.published) throw new ApiError(403, `Model not published: ${model.name}`);

  const latestVersion = await prisma.modelVersion.findFirst({
    where: { modelId: model.id },
    orderBy: { versionNumber: "desc" },
  });

  return { model, latestVersion };
}

async function getLatestPublishedVersionForModelName(modelName: string) {
  const model = await prisma.modelDefinition.findFirst({
    where: {
      OR: [
        { name: { equals: modelName, mode: "insensitive" } },
        { tableName: { equals: modelName, mode: "insensitive" } },
        { name: modelName },
        { tableName: modelName },
      ],
    },
  });
  if (!model || !model.published) return null;
  const v = await prisma.modelVersion.findFirst({ where: { modelId: model.id }, orderBy: { versionNumber: "desc" } });
  return v ?? null;
}

/* ------------------------ Validation helpers ------------------------- */
export function validatePayloadAgainstModel(definition: any, payload: any) {
  const def = extractDefinitionFromJson(definition);
  const fields = def?.fields ?? def?.schema?.fields ?? [];
  if (!Array.isArray(fields)) return;

  for (const f of fields) {
    if (!f || !f.name) continue;
    const val = payload?.[f.name];

    if (f.required && (val === undefined || val === null || val === "")) {
      throw new ApiError(400, `Field '${f.name}' is required`);
    }

    if (val !== undefined && val !== null) {
      const t = String(f.type ?? "string").toLowerCase();
      if ((t === "number" || t === "int" || t === "float") && typeof val !== "number") {
        throw new ApiError(400, `Field '${f.name}' should be a number`);
      }
      if (t === "string" && typeof val !== "string") {
        throw new ApiError(400, `Field '${f.name}' should be a string`);
      }
      if (t === "boolean" && typeof val !== "boolean") {
        throw new ApiError(400, `Field '${f.name}' should be a boolean`);
      }

      if (t === "relation") {
        const relType = canonicalRelationType(f.relation);
        if (relType === "one-to-many" || relType === "many-to-many") {
          if (!Array.isArray(val)) throw new ApiError(400, `Relation field '${f.name}' expects an array of ids/values`);
        } else {
          if (Array.isArray(val)) throw new ApiError(400, `Relation field '${f.name}' expects a single id/value`);
        }
      }
    }
  }
}

/* -------------------- Relation resolution helpers -------------------- */

/**
 * Resolve a single target id for a relation field.
 * Special-case system User model resolution.
 */
async function resolveSingleRelationTargetId(targetModelName: string, targetFieldName: string, providedValue: any) {
  if (providedValue === undefined || providedValue === null || providedValue === "") {
    throw new ApiError(400, `Relation expects a value for ${targetModelName}.${targetFieldName}`);
  }

  // Special-case: system-level User relations (map to prisma.user)
  if (String(targetModelName).toLowerCase() === "user") {
    const candidate = String(providedValue);
    let u = await prisma.user.findUnique({ where: { id: candidate } });
    if (u) return u.id;
    u = await prisma.user.findUnique({ where: { email: candidate } });
    if (u) return u.id;

    // try mapping from a dynamic record (data.email etc.)
    try {
      const rec = await prisma.record.findUnique({ where: { id: candidate } });
      if (rec && rec.data && typeof rec.data === "object") {
        const data = rec.data as any;
        const candidates = [data.email, data.emailAddress, data.userEmail, data.username, data.name].filter(Boolean);
        for (const c of candidates) {
          const maybe = String(c);
          const uu = await prisma.user.findUnique({ where: { email: maybe } });
          if (uu) return uu.id;
        }
      }
    } catch {
      // ignore
    }

    throw new ApiError(400, `Related system user not found for value '${providedValue}'`);
  }

  // Non-user target: must reference a published model
  const targetModel = await prisma.modelDefinition.findFirst({
    where: {
      OR: [
        { name: { equals: targetModelName, mode: "insensitive" } },
        { tableName: { equals: targetModelName, mode: "insensitive" } },
        { name: targetModelName },
        { tableName: targetModelName },
      ],
    },
  });
  if (!targetModel || !targetModel.published) {
    throw new ApiError(400, `Relation target model '${targetModelName}' not found or unpublished`);
  }

  const candidate = String(providedValue);
  // Try direct id (record id)
  const maybeRec = await prisma.record.findUnique({ where: { id: candidate } });
  if (maybeRec && (maybeRec.modelName ?? "").toLowerCase() === String(targetModel.name ?? "").toLowerCase()) {
    return maybeRec.id;
  }

  // Otherwise search records in that model where data[targetFieldName] == providedValue
  const matches = await prisma.record.findMany({
    where: { modelId: targetModel.id },
    select: { id: true, data: true },
    take: 200, // cap
  });

  const matched = matches.filter((r) => {
    if (!r.data || typeof r.data !== "object") return false;
    const v = (r.data as any)[targetFieldName];
    if (v === undefined || v === null) return false;
    return String(v) === candidate;
  });

  if (matched.length === 1) return matched[0].id;
  if (matched.length === 0) {
    throw new ApiError(400, `Related record not found in model '${targetModelName}' where ${targetFieldName} == '${providedValue}'`);
  }
  throw new ApiError(400, `Ambiguous relation value for ${targetModelName}.${targetFieldName}='${providedValue}': ${matched.length} matches found. Use the target record id instead.`);
}

async function validateRelationTargets(definition: any, payload: any) {
  const def = extractDefinitionFromJson(definition);
  const fields = def?.fields ?? [];
  if (!Array.isArray(fields)) return;

  for (const f of fields) {
    if (!f || String(f.type).toLowerCase() !== "relation") continue;
    const rel = f.relation ?? {};
    const targetModelName = rel?.model;
    const targetFieldName = rel?.field ?? "id";
    if (!targetModelName) throw new ApiError(400, `Relation field '${f.name}' missing relation.model`);
    if (!targetFieldName) throw new ApiError(400, `Relation field '${f.name}' missing relation.field`);

    const relType = canonicalRelationType(rel);
    const rawVal = payload?.[f.name];
    if (rawVal === undefined || rawVal === null) continue;

    if (relType === "many-to-many" || relType === "one-to-many") {
      if (!Array.isArray(rawVal)) throw new ApiError(400, `Relation '${f.name}' expects an array`);
      const uniqueVals = Array.from(new Set((rawVal as any[]).map((v) => normalizeId(v))));
      const ids: string[] = [];
      for (const v of uniqueVals) {
        const resolved = await resolveSingleRelationTargetId(targetModelName, targetFieldName, v);
        ids.push(resolved);
      }
      payload[f.name] = ids;
      continue;
    }

    if (Array.isArray(rawVal)) throw new ApiError(400, `Relation '${f.name}' expects a single id/value`);
    const resolvedId = await resolveSingleRelationTargetId(targetModelName, targetFieldName, rawVal);
    payload[f.name] = resolvedId;
  }
}

/* -------------------- Uniqueness / linking checks -------------------- */
async function enforceLinkingModelCompositeUniqueness(
  modelDef: any,
  schemaSnapshot: any,
  payload: any,
  opts?: { excludeRecordId?: string | null }
) {
  const fields = fieldsFromDefinition(schemaSnapshot);
  const relationFields = fields.filter((f) => f && String(f.type).toLowerCase() === "relation");

  const singleIdRelationFields = relationFields.filter((f) => {
    const relType = canonicalRelationType(f.relation);
    return relType === "many-to-one" || relType === "one-to-one";
  });

  if (singleIdRelationFields.length < 2) return;

  const pairs: Array<{ fieldName: string; value: string }> = [];
  for (const rf of singleIdRelationFields) {
    const v = payload?.[rf.name];
    if (v === undefined || v === null) {
      return;
    }
    if (Array.isArray(v)) throw new ApiError(400, `Linking model field '${rf.name}' expects single id (not array)`);
    pairs.push({ fieldName: rf.name, value: normalizeId(v) });
  }

  const existingRecords = await prisma.record.findMany({
    where: { modelId: modelDef.id },
    select: { id: true, data: true },
    take: 2000,
  });

  const match = existingRecords.find((r) => {
    if (!r.data || typeof r.data !== "object" || Array.isArray(r.data)) return false;
    if (opts?.excludeRecordId && r.id === opts.excludeRecordId) return false;
    const dataObj = r.data as Record<string, any>;
    for (const p of pairs) {
      const dv = normalizeId(dataObj[p.fieldName]);
      if (dv !== p.value) return false;
    }
    return true;
  });

  if (match) {
    const parts = pairs.map((p) => `${p.fieldName}=${p.value}`).join(", ");
    throw new ApiError(400, `Duplicate link detected: record with (${parts}) already exists (id=${match.id})`);
  }
}

/* ------------------------ Record <-> Origin resolution -----------------
 *
 * We must support:
 *  - frontend sending roleId that is a Role-model-record id (record.id). We must map that
 *    to the Role table id (origin) before writing to prisma.user.roleId.
 *  - when returning User records, map system roleId -> role record id (so client continues to work).
 *
 * Helpers below:
 */

/** Given either a system-id or a model-record-id, resolve to the system-origin id (role table id). */
async function resolveSystemOriginIdFromCandidate(candidate: any, targetModelName: string): Promise<string | null> {
  if (candidate === undefined || candidate === null || candidate === "") return null;
  const s = String(candidate);

  // 1) if candidate is already a system id (exists in the system table), return as-is
  if (String(targetModelName).toLowerCase() === "role") {
    const sys = await prisma.role.findUnique({ where: { id: s } });
    if (sys) return sys.id;
  }
  if (String(targetModelName).toLowerCase() === "user") {
    const sys = await prisma.user.findUnique({ where: { id: s } });
    if (sys) return sys.id;
  }

  // 2) try candidate as a record id => read record and extract origin id
  try {
    const rec = await prisma.record.findUnique({ where: { id: s }, select: { id: true, modelName: true, data: true } });
    if (rec && rec.modelName && String(rec.modelName).toLowerCase() === String(targetModelName).toLowerCase()) {
      const origin = originIdFromRecordData(rec.data);
      if (origin) return origin;
    }
  } catch {
    // ignore
  }

  // 3) Not found
  return null;
}

/** Given a system-origin id (role table id), find the corresponding record id in Role model (if exists) */
async function findRecordIdForOrigin(originId: string, targetModelName: string): Promise<string | null> {
  if (!originId) return null;
  // Find candidate role records with modelName === targetModelName and pick the one whose data.id === originId or _origin.id === originId
  const recs = await prisma.record.findMany({ where: { modelName: { equals: targetModelName, mode: "insensitive" } }, select: { id: true, data: true }, take: 2000 });
  for (const r of recs) {
    const orig = originIdFromRecordData(r.data);
    if (orig && String(orig) === String(originId)) return r.id;
  }
  return null;
}

/* ----------------------- Owner resolution ---------------------------- */
async function resolveSystemUserIdFromCandidate(candidate: any): Promise<string | null> {
  if (candidate === undefined || candidate === null || candidate === "") return null;
  const s = String(candidate);

  let u = await prisma.user.findUnique({ where: { id: s } });
  if (u) return u.id;
  u = await prisma.user.findUnique({ where: { email: s } });
  if (u) return u.id;

  try {
    const rec = await prisma.record.findUnique({ where: { id: s } });
    if (rec && rec.data && typeof rec.data === "object") {
      const data = rec.data as any;
      const candidates = [data.email, data.emailAddress, data.userEmail, data.username, data.name].filter(Boolean);
      for (const c of candidates) {
        const maybe = String(c);
        const uu = await prisma.user.findUnique({ where: { email: maybe } });
        if (uu) return uu.id;
      }
    }
  } catch {
    // ignore
  }

  return null;
}

/* --------------------------- CRUD ----------------------------------- */

/**
 * Create record service.
 * If model.isSystem => create system table row first (user/role), then create record mirror inside single transaction.
 */
export async function createRecordService(modelRouteName: string, payload: any, actingUserId?: string | null) {
  const { model, latestVersion } = await resolvePublishedModel(modelRouteName);
  const schemaToUse = latestVersion?.json ?? model.json ?? {};

  // validate shape against schema
  validatePayloadAgainstModel(schemaToUse, payload);

  // resolve relations (will replace candidate values with ids where applicable)
  await validateRelationTargets(schemaToUse, payload);

  // enforce linking uniqueness if required
  await enforceLinkingModelCompositeUniqueness(model, schemaToUse, payload);

  // owner resolution
  let ownerToPersist: string | null = null;
  if (payload && payload.ownerId !== undefined) {
    ownerToPersist = await resolveSystemUserIdFromCandidate(payload.ownerId);
    if (!ownerToPersist) throw new ApiError(400, `ownerId '${payload.ownerId}' could not be resolved to a system user.`);
  } else if (model.ownerField && payload && payload[model.ownerField] !== undefined) {
    ownerToPersist = await resolveSystemUserIdFromCandidate(payload[model.ownerField]);
    if (!ownerToPersist) throw new ApiError(400, `Owner field '${model.ownerField}' provided but could not be resolved to a system user.`);
  } else if (actingUserId) {
    const u = await prisma.user.findUnique({ where: { id: actingUserId } });
    if (u) ownerToPersist = actingUserId;
  }

  if (model.ownerField && (!payload || payload[model.ownerField] === undefined) && ownerToPersist) {
    payload = { ...(payload ?? {}), [model.ownerField]: ownerToPersist };
  }

  // System models: handle dual-write into system table + record table
  if (model.isSystem) {
    const modelName = String(model.name ?? "").toLowerCase();

    // ----- USER -----
    if (modelName === "user") {
      if (!payload.email) throw new ApiError(400, "User must include 'email' field");
      const password = payload.password ?? null;
      const hashed = password ? await bcrypt.hash(String(password), HASH_ROUNDS) : undefined;

      // support roleName or roleId which may be a role-record-id
      let roleIdToSet: string | null = null;
      if (payload.roleId) {
        // payload.roleId may be: system role id OR role model record id
        const resolved = await resolveSystemOriginIdFromCandidate(payload.roleId, "Role");
        if (!resolved) throw new ApiError(400, `Provided roleId '${payload.roleId}' could not be resolved to a system Role id or Role record.`);
        roleIdToSet = resolved;
      } else if (payload.roleName) {
        const roleRow = await prisma.role.findUnique({ where: { name: payload.roleName } });
        if (roleRow) roleIdToSet = roleRow.id;
      }

      try {
        const txResult = await prisma.$transaction(async (tx) => {
          // create user first
          const createdUser = await tx.user.create({
            data: {
              name: payload.name ?? null,
              email: payload.email,
              password: hashed ?? String(payload.password ?? ""),
              roleId: roleIdToSet ?? null,
              isActive: payload.isActive ?? true,
            } as any,
          });

          // don't store raw password in record data
          const recordData = asRecordObject(payload);
          if ("password" in recordData) delete recordData.password;
          // ensure id/email fields present (origin id)
          recordData.id = createdUser.id;
          recordData.email = createdUser.email;

          const createdRecord = await tx.record.create({
            data: {
              modelId: model.id,
              modelName: model.name,
              modelVersionId: latestVersion ? latestVersion.id : null,
              data: recordData,
              ownerId: ownerToPersist ?? null,
            },
          });

          await tx.auditLog.create({
            data: {
              userId: actingUserId ?? null,
              action: "SYSTEM_USER_CREATE",
              modelId: model.id,
              modelName: model.name,
              recordId: createdRecord.id,
              details: { userId: createdUser.id, payload: recordData },
            },
          });

          return { createdUser, createdRecord };
        });

        return txResult.createdRecord;
      } catch (err: any) {
        if (err && err.code === "P2002") {
          // unique constraint failed (email)
          throw new ApiError(400, `Unique constraint failed: ${JSON.stringify(err.meta ?? err.message)}`);
        }
        throw new ApiError(500, `Failed creating system user: ${err?.message ?? String(err)}`);
      }
    }

    // ----- ROLE -----
    if (modelName === "role") {
      if (!payload.name) throw new ApiError(400, "Role must include 'name' field");
      try {
        const txResult = await prisma.$transaction(async (tx) => {
          const createdRole = await tx.role.create({
            data: {
              name: payload.name,
              description: payload.description ?? null,
              isSystem: payload.isSystem ?? false,
            } as any,
          });

          const recordData = asRecordObject(payload);
          if ("password" in recordData) delete recordData.password;
          recordData.id = createdRole.id;
          recordData.name = createdRole.name;

          const createdRecord = await tx.record.create({
            data: {
              modelId: model.id,
              modelName: model.name,
              modelVersionId: latestVersion ? latestVersion.id : null,
              data: recordData,
              ownerId: ownerToPersist ?? null,
            },
          });

          await tx.auditLog.create({
            data: {
              userId: actingUserId ?? null,
              action: "SYSTEM_ROLE_CREATE",
              modelId: model.id,
              modelName: model.name,
              recordId: createdRecord.id,
              details: { roleId: createdRole.id, payload: recordData },
            },
          });

          return { createdRole, createdRecord };
        });

        return txResult.createdRecord;
      } catch (err: any) {
        if (err && err.code === "P2002") {
          throw new ApiError(400, `Unique constraint failed: ${JSON.stringify(err.meta ?? err.message)}`);
        }
        throw new ApiError(500, `Failed creating system role: ${err?.message ?? String(err)}`);
      }
    }

    throw new ApiError(400, `System model '${model.name}' not supported for create via API`);
  }

  // Non-system model: create record only
  try {
    const created = await prisma.record.create({
      data: {
        modelId: model.id,
        modelName: model.name,
        modelVersionId: latestVersion ? latestVersion.id : null,
        data: payload,
        ownerId: ownerToPersist ?? null,
      },
    });

    await prisma.auditLog.create({
      data: {
        userId: actingUserId ?? null,
        action: "RECORD_CREATE",
        modelId: model.id,
        modelName: model.name,
        recordId: created.id,
        details: { payload },
      },
    });

    return created;
  } catch (err: any) {
    if (err && err.code === "P2003") {
      throw new ApiError(400, `Foreign key constraint failed while creating record.`);
    }
    throw new ApiError(500, `Database error: ${err?.message ?? String(err)}`);
  }
}

/**
 * listRecordsService: when model.isSystem => fetch from system table and map to record-like objects.
 * For system users: map system roleId -> roleModelRecordId so clients expecting record ids continue to work.
 */
export async function listRecordsService(modelRouteName: string, opts?: { limit?: number; skip?: number; ownerOnly?: boolean; userId?: string | null }) {
  const { model } = await resolvePublishedModel(modelRouteName);

  const limit = Math.min(200, Math.max(1, Number(opts?.limit ?? 20)));
  const skip = Math.max(0, Number(opts?.skip ?? 0));

  if (model.isSystem) {
    const modelName = String(model.name ?? "").toLowerCase();

    // Preload mapping Role-system-id -> Role-record-id (for mapping user.roleId -> roleRecordId)
    let roleOriginToRecordMap: Map<string, string> | null = null;
    try {
      const roleModelDef = await prisma.modelDefinition.findFirst({ where: { OR: [{ name: { equals: "Role", mode: "insensitive" } }, { tableName: { equals: "roles", mode: "insensitive" } }, { name: "Role" }] } });
      if (roleModelDef) {
        const roleRecs = await prisma.record.findMany({ where: { modelId: roleModelDef.id }, select: { id: true, data: true }, take: 2000 });
        roleOriginToRecordMap = new Map(roleRecs.map(r => [String(originIdFromRecordData(r.data) ?? ""), r.id]));
      }
    } catch {
      // ignore - fallback to no mapping
      roleOriginToRecordMap = null;
    }

    if (modelName === "user") {
      const where: any = {};
      if (opts?.ownerOnly && opts.userId) where.id = String(opts.userId);
      const total = await prisma.user.count({ where });
      const itemsRaw = await prisma.user.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
        select: { id: true, name: true, email: true, roleId: true, isActive: true, createdAt: true, updatedAt: true },
      });

      const items = itemsRaw.map((u) => {
        // map roleId (system id) -> role record id if available
        let mappedRoleRecordId: string | null = null;
        if (u.roleId && roleOriginToRecordMap) {
          mappedRoleRecordId = roleOriginToRecordMap.get(String(u.roleId)) ?? null;
        }
        return {
          id: u.id,
          modelId: model.id,
          modelName: model.name,
          data: { id: u.id, name: u.name, email: u.email, roleId: mappedRoleRecordId ?? u.roleId, isActive: u.isActive },
          ownerId: null,
          createdAt: u.createdAt,
          updatedAt: u.updatedAt,
        };
      });
      return { total, items };
    }

    if (modelName === "role") {
      const where: any = {};
      const total = await prisma.role.count({ where });
      const itemsRaw = await prisma.role.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
        select: { id: true, name: true, description: true, isSystem: true, createdAt: true, updatedAt: true },
      });
      const items = itemsRaw.map((r) => ({
        id: r.id,
        modelId: model.id,
        modelName: model.name,
        data: { id: r.id, name: r.name, description: r.description, isSystem: r.isSystem },
        ownerId: null,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      }));
      return { total, items };
    }

    // fallback: map records if unknown system model
  }

  const where: any = { modelId: model.id };
  if (opts?.ownerOnly && opts.userId) where.ownerId = String(opts.userId);

  const [items, total] = await Promise.all([
    prisma.record.findMany({ where, orderBy: { createdAt: "desc" }, skip, take: limit, include: { modelVersion: true } }),
    prisma.record.count({ where }),
  ]);

  let finalItems = items;
  if (opts?.ownerOnly && model.ownerField) {
    finalItems = items.filter((r) => {
      try {
        if (r.ownerId && String(r.ownerId) === String(opts.userId)) return true;
        const dataObj = r.data;
        if (dataObj && typeof dataObj === "object" && !Array.isArray(dataObj)) {
          const maybe = (dataObj as any)[model.ownerField as string];
          if (maybe && String(maybe) === String(opts.userId)) return true;
        }
        return false;
      } catch {
        return false;
      }
    });
  }

  return { total, items: finalItems };
}

export async function getRecordService(modelRouteName: string, id: string) {
  const { model } = await resolvePublishedModel(modelRouteName);

  // If system model, support fetching by either system-id or record-id (map record-id -> origin id)
  if (model.isSystem) {
    const modelName = String(model.name ?? "").toLowerCase();

    // If the passed id is a record id, try to resolve origin id
    let systemIdCandidate = String(id);
    try {
      const rec = await prisma.record.findUnique({ where: { id } });
      if (rec && rec.modelName && String(rec.modelName).toLowerCase() === modelName) {
        const origin = originIdFromRecordData(rec.data);
        if (origin) systemIdCandidate = origin;
      }
    } catch {
      // ignore
    }

    if (modelName === "user") {
      const u = await prisma.user.findUnique({ where: { id: systemIdCandidate } });
      if (!u) throw new ApiError(404, "User not found");

      // Map role system-id -> role-record-id if exists
      let mappedRoleRecordId: string | null = null;
      const roleRecId = await findRecordIdForOrigin(String(u.roleId ?? ""), "Role");
      if (roleRecId) mappedRoleRecordId = roleRecId;

      return {
        id: u.id,
        modelId: model.id,
        modelName: model.name,
        data: { id: u.id, name: u.name, email: u.email, roleId: mappedRoleRecordId ?? u.roleId, isActive: u.isActive },
        ownerId: null,
        createdAt: u.createdAt,
        updatedAt: u.updatedAt,
      } as any;
    }

    if (modelName === "role") {
      const r = await prisma.role.findUnique({ where: { id: systemIdCandidate } });
      if (!r) throw new ApiError(404, "Role not found");
      return {
        id: r.id,
        modelId: model.id,
        modelName: model.name,
        data: { id: r.id, name: r.name, description: r.description, isSystem: r.isSystem },
        ownerId: null,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      } as any;
    }

    throw new ApiError(400, `System model '${model.name}' not supported for get`);
  }

  const rec = await prisma.record.findUnique({ where: { id }, include: { modelVersion: true } });
  if (!rec) throw new ApiError(404, "Record not found");
  if (rec.modelId !== model.id) throw new ApiError(404, "Record not found for this model");
  return rec;
}

/**
 * Update record service.
 * If model.isSystem: update system table first then mirror record (transactional).
 *
 * Important: the `id` parameter may be either:
 *  - the system table id (prisma.user.id / prisma.role.id) OR
 *  - a model record id (prisma.record.id). We try to resolve record->origin automatically.
 */
export async function updateRecordService(modelRouteName: string, id: string, payload: any, actingUserId?: string | null) {
  const { model } = await resolvePublishedModel(modelRouteName);

  // If system model, support id being record-id (map to origin id) before doing system updates.
  if (model.isSystem) {
    const modelName = String(model.name ?? "").toLowerCase();

    // Resolve id -> system origin id if needed
    let systemId = String(id);
    try {
      const rec = await prisma.record.findUnique({ where: { id } });
      if (rec && rec.modelName && String(rec.modelName).toLowerCase() === modelName) {
        const origin = originIdFromRecordData(rec.data);
        if (origin) systemId = origin;
      }
    } catch {
      // ignore
    }

    // ---- USER update ----
    if (modelName === "user") {
      const up: any = {};
      if (payload.name !== undefined) up.name = payload.name;
      if (payload.email !== undefined) up.email = payload.email;
      if (payload.password !== undefined) up.password = await bcrypt.hash(String(payload.password), HASH_ROUNDS);
      if (payload.roleId !== undefined) {
        // payload.roleId may be a role record id -> map to role.origin id
        const resolvedRoleOrigin = await resolveSystemOriginIdFromCandidate(payload.roleId, "Role");
        if (!resolvedRoleOrigin) throw new ApiError(400, `Provided roleId '${payload.roleId}' could not be resolved to a system Role id or Role record.`);
        up.roleId = resolvedRoleOrigin;
      }
      if (payload.isActive !== undefined) up.isActive = payload.isActive;

      try {
        const txResult = await prisma.$transaction(async (tx) => {
          const existingUser = await tx.user.findUnique({ where: { id: systemId } });
          if (!existingUser) throw new ApiError(404, "User not found");

          const updatedUser = await tx.user.update({ where: { id: systemId }, data: up });

          // find mirror record by modelId and data.id == user.id (filter in JS)
          const candidates = await tx.record.findMany({ where: { modelId: model.id }, select: { id: true, data: true } });
          let recordToUpdate = candidates.find((c) => {
            try {
              if (!c.data || typeof c.data !== "object") return false;
              return String((c.data as any).id) === String(updatedUser.id);
            } catch {
              return false;
            }
          });

          const existingRecordData: Record<string, any> = asRecordObject(recordToUpdate?.data);
          const incomingPayload: Record<string, any> = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
          const mergedData: Record<string, any> = { ...existingRecordData, ...incomingPayload };
          if ("password" in mergedData) delete mergedData.password;

          mergedData.id = updatedUser.id;
          mergedData.email = updatedUser.email;
          mergedData.name = updatedUser.name;
          mergedData.roleId = updatedUser.roleId;
          mergedData.isActive = updatedUser.isActive;

          if (recordToUpdate) {
            await tx.record.update({ where: { id: recordToUpdate.id }, data: { data: mergedData, updatedAt: new Date() as any } });
          } else {
            await tx.record.create({ data: { modelId: model.id, modelName: model.name, modelVersionId: null, data: mergedData, ownerId: null } });
          }

          await tx.auditLog.create({
            data: {
              userId: actingUserId ?? null,
              action: "SYSTEM_USER_UPDATE",
              modelId: model.id,
              modelName: model.name,
              recordId: updatedUser.id,
              details: { payload },
            },
          });

          return updatedUser;
        });

        return txResult as any;
      } catch (err: any) {
        if (err && err.code === "P2002") throw new ApiError(400, `Unique constraint failed: ${JSON.stringify(err.meta ?? err.message)}`);
        throw err;
      }
    }

    // ---- ROLE update ----
    if (modelName === "role") {
      const up: any = {};
      if (payload.name !== undefined) up.name = payload.name;
      if (payload.description !== undefined) up.description = payload.description;
      if (payload.isSystem !== undefined) up.isSystem = !!payload.isSystem;

      try {
        const txResult = await prisma.$transaction(async (tx) => {
          const existingRole = await tx.role.findUnique({ where: { id: systemId } });
          if (!existingRole) throw new ApiError(404, "Role not found");

          const updatedRole = await tx.role.update({ where: { id: systemId }, data: up });

          const candidates = await tx.record.findMany({ where: { modelId: model.id }, select: { id: true, data: true } });
          let rec = candidates.find((c) => {
            try {
              if (!c.data || typeof c.data !== "object") return false;
              return String((c.data as any).id) === String(updatedRole.id);
            } catch {
              return false;
            }
          });

          const existingRoleRecordData: Record<string, any> = asRecordObject(rec?.data);
          const incomingRolePayload: Record<string, any> = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
          const mergedData: Record<string, any> = { ...existingRoleRecordData, ...incomingRolePayload };

          mergedData.id = updatedRole.id;
          mergedData.name = updatedRole.name;
          mergedData.description = updatedRole.description;
          mergedData.isSystem = updatedRole.isSystem;

          if (rec) {
            await tx.record.update({ where: { id: rec.id }, data: { data: mergedData, updatedAt: new Date() as any } });
          } else {
            await tx.record.create({ data: { modelId: model.id, modelName: model.name, modelVersionId: null, data: mergedData, ownerId: null } });
          }

          await tx.auditLog.create({
            data: {
              userId: actingUserId ?? null,
              action: "SYSTEM_ROLE_UPDATE",
              modelId: model.id,
              modelName: model.name,
              recordId: updatedRole.id,
              details: { payload },
            },
          });

          return updatedRole;
        });

        return txResult as any;
      } catch (err: any) {
        if (err && err.code === "P2002") throw new ApiError(400, `Unique constraint failed: ${JSON.stringify(err.meta ?? err.message)}`);
        throw err;
      }
    }

    throw new ApiError(400, `System model '${model.name}' not supported for update`);
  }

  // Non-system update flow (existing record)
  const rec = await prisma.record.findUnique({ where: { id }, include: { modelVersion: true } });
  if (!rec) throw new ApiError(404, "Record not found");
  if (rec.modelId !== model.id) throw new ApiError(400, "Record-model mismatch");

  const latestPublished = await prisma.modelVersion.findFirst({ where: { modelId: model.id }, orderBy: { versionNumber: "desc" } });
  const schemaToUse = rec.modelVersion?.json ?? latestPublished?.json ?? model.json ?? {};

  validatePayloadAgainstModel(schemaToUse, payload);
  await validateRelationTargets(schemaToUse, payload);

  const existingData: Record<string, any> = asRecordObject(rec.data);
  const incomingPayload: Record<string, any> = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
  const merged: Record<string, any> = { ...existingData, ...incomingPayload };

  await enforceLinkingModelCompositeUniqueness(model, schemaToUse, merged, { excludeRecordId: rec.id });

  if (payload && (payload.ownerId !== undefined || (model.ownerField && payload[model.ownerField] !== undefined))) {
    const ownerField = model.ownerField as string | undefined;
    const candidate = payload.ownerId ?? (ownerField ? payload[ownerField] : undefined);
    const resolved = await resolveSystemUserIdFromCandidate(candidate);
    if (!resolved) throw new ApiError(400, "Provided owner value could not be resolved to a system user.");
    merged.ownerId = resolved;
    if (ownerField) merged[ownerField] = resolved;
  }

  try {
    const updated = await prisma.record.update({ where: { id }, data: { data: merged, updatedAt: new Date() as any } });

    await prisma.auditLog.create({
      data: {
        userId: actingUserId ?? null,
        action: "RECORD_UPDATE",
        modelId: rec.modelId,
        modelName: rec.modelName,
        recordId: rec.id,
        details: { payload },
      },
    });

    return updated;
  } catch (err: any) {
    if (err && err.code === "P2003") throw new ApiError(400, `Foreign key constraint failed while updating record.`);
    throw new ApiError(500, `Database error: ${err?.message ?? String(err)}`);
  }
}

export async function deleteRecordService(modelRouteName: string, id: string, actingUserId?: string | null) {
  const { model } = await resolvePublishedModel(modelRouteName);

  if (model.isSystem) {
    const modelName = String(model.name ?? "").toLowerCase();

    // resolve id -> system id if id is record id
    let systemId = String(id);
    try {
      const rec = await prisma.record.findUnique({ where: { id } });
      if (rec && rec.modelName && String(rec.modelName).toLowerCase() === modelName) {
        const origin = originIdFromRecordData(rec.data);
        if (origin) systemId = origin;
      }
    } catch {
      // ignore
    }

    if (modelName === "user") {
      try {
        await prisma.$transaction(async (tx) => {
          const u = await tx.user.findUnique({ where: { id: systemId } });
          if (!u) throw new ApiError(404, "User not found");

          await tx.user.delete({ where: { id: systemId } });

          // delete mirror records where data.id == systemId (filter in JS)
          const candidates = await tx.record.findMany({ where: { modelId: model.id }, select: { id: true, data: true } });
          const toDeleteIds = candidates.filter((c) => {
            try {
              if (!c.data || typeof c.data !== "object") return false;
              return String((c.data as any).id) === String(systemId);
            } catch {
              return false;
            }
          }).map(c => c.id);

          if (toDeleteIds.length) await tx.record.deleteMany({ where: { id: { in: toDeleteIds } } });

          await tx.auditLog.create({
            data: {
              userId: actingUserId ?? null,
              action: "SYSTEM_USER_DELETE",
              modelId: model.id,
              modelName: model.name,
              recordId: systemId,
              details: {},
            },
          });
        });

        return { deleted: true };
      } catch (err: any) {
        throw err;
      }
    }

    if (modelName === "role") {
      try {
        await prisma.$transaction(async (tx) => {
          const r = await tx.role.findUnique({ where: { id: systemId } });
          if (!r) throw new ApiError(404, "Role not found");
          await tx.role.delete({ where: { id: systemId } });

          const candidates = await tx.record.findMany({ where: { modelId: model.id }, select: { id: true, data: true } });
          const toDeleteIds = candidates.filter((c) => {
            try {
              if (!c.data || typeof c.data !== "object") return false;
              return String((c.data as any).id) === String(systemId);
            } catch {
              return false;
            }
          }).map(c => c.id);

          if (toDeleteIds.length) await tx.record.deleteMany({ where: { id: { in: toDeleteIds } } });

          await tx.auditLog.create({
            data: {
              userId: actingUserId ?? null,
              action: "SYSTEM_ROLE_DELETE",
              modelId: model.id,
              modelName: model.name,
              recordId: systemId,
              details: {},
            },
          });
        });

        return { deleted: true };
      } catch (err: any) {
        throw err;
      }
    }

    throw new ApiError(400, `System model '${model.name}' not supported for delete`);
  }

  const rec = await prisma.record.findUnique({ where: { id } });
  if (!rec) throw new ApiError(404, "Record not found");
  if (rec.modelId !== model.id) throw new ApiError(400, "Record-model mismatch");

  await prisma.record.delete({ where: { id } });

  await prisma.auditLog.create({
    data: {
      userId: actingUserId ?? null,
      action: "RECORD_DELETE",
      modelId: rec.modelId,
      modelName: rec.modelName,
      recordId: rec.id,
      details: {},
    },
  });

  return { deleted: true };
}

/* -------------------------- Exports --------------------------------- */
export default {
  createRecordService,
  listRecordsService,
  getRecordService,
  updateRecordService,
  deleteRecordService,
  resolvePublishedModel,
};
