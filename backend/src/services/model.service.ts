// src/services/model.service.ts
import fs from "fs";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import prisma from "../utils/prisma";
import { ApiError } from "../handlers/errorHandler";

/**
 * Config
 */
const MODELS_DIR =
  process.env.MODELS_DIR ?? path.resolve(process.cwd(), "models");
const TMP_SUFFIX = ".tmp";
const SYSTEM_SENTINEL_PREFIX = "system:"; // used for synthetic IDs returned to frontend

function ensureModelsDir() {
  if (!fs.existsSync(MODELS_DIR)) fs.mkdirSync(MODELS_DIR, { recursive: true });
}

/**
 * Helpers to extract canonical definition / fields from saved json shapes
 */
function extractDefinitionFromJson(json: any): any {
  if (!json || typeof json !== "object" || Array.isArray(json)) return {};
  // support both { definition: { fields: [...] } } or direct { fields: [...] }
  return (json.definition ?? json) as Record<string, any>;
}

function fieldsFromDefinition(json: any): any[] {
  const def = extractDefinitionFromJson(json);
  return Array.isArray(def.fields) ? def.fields : [];
}

/**
 * Validate minimal model JSON structure coming from the UI.
 * Extended: validate relation fields shape (but not cross-model existence).
 */
export function validateModelJson(obj: any) {
  if (!obj || typeof obj !== "object") {
    throw new ApiError(400, "Model json must be an object");
  }
  const canonical = extractDefinitionFromJson(obj);
  if (!Array.isArray(canonical.fields)) {
    throw new ApiError(400, "Model json must include a 'fields' array");
  }
  for (const f of canonical.fields) {
    if (!f || typeof f !== "object") {
      throw new ApiError(400, "Each field must be an object");
    }
    if (!f.name || typeof f.name !== "string") {
      throw new ApiError(400, "Each field must include a 'name' string");
    }
    if (!f.type || typeof f.type !== "string") {
      throw new ApiError(400, "Each field must include a 'type' string");
    }

    // Relation shape validation
    const t = String(f.type).toLowerCase();
    if (t === "relation") {
      if (!f.relation || typeof f.relation !== "object") {
        throw new ApiError(
          400,
          `Relation field '${f.name}' must include a 'relation' object`
        );
      }
      const {
        model: relModel,
        field: relField,
        type: relType,
      } = f.relation as any;
      if (!relModel || typeof relModel !== "string") {
        throw new ApiError(
          400,
          `Relation '${f.name}' must specify relation.model (target model name)`
        );
      }
      if (!relField || typeof relField !== "string") {
        throw new ApiError(
          400,
          `Relation '${f.name}' must specify relation.field (target field name)`
        );
      }
      if (!relType || typeof relType !== "string") {
        throw new ApiError(
          400,
          `Relation '${f.name}' must specify relation.type (e.g. 'many-to-one')`
        );
      }
      // restrict allowed relation types to a small canonical set
      const allowed = new Set([
        "one-to-one",
        "one-to-many",
        "many-to-one",
        "many-to-many",
      ]);
      if (!allowed.has(String(relType).toLowerCase())) {
        throw new ApiError(
          400,
          `Relation '${
            f.name
          }' has unsupported relation.type '${relType}'. Allowed: ${Array.from(
            allowed
          ).join(", ")}`
        );
      }
    }
  }
}

/**
 * Build the final file content (shape) to write to disk.
 */
function buildModelFileContent(modelDef: any) {
  const base = modelDef.json ?? {};
  return {
    id: modelDef.id,
    name: modelDef.name,
    tableName: modelDef.tableName ?? null,
    ownerField: modelDef.ownerField ?? null,
    version: modelDef.version ?? 1,
    publishedAt: new Date().toISOString(),
    definition: base,
  };
}

/**
 * Resolve latest published ModelVersion for a model name (returns null if model not published)
 */
async function getLatestPublishedVersionForModelName(modelName: string) {
  const model = await prisma.modelDefinition.findFirst({
    where: { OR: [{ name: modelName }, { tableName: modelName }] },
  });
  if (!model || !model.published) return null;
  const v = await prisma.modelVersion.findFirst({
    where: { modelId: model.id },
    orderBy: { versionNumber: "desc" },
  });
  return v ?? null;
}

/**
 * Helper: ensure relation target exists & published and target snapshot contains referenced field.
 * Throws ApiError on failure.
 */
async function validateRelationTargets(
  canonicalDef: any,
  selfModelName: string
) {
  if (!Array.isArray(canonicalDef.fields)) return;
  for (const f of canonicalDef.fields) {
    if (!f || String(f.type).toLowerCase() !== "relation") continue;
    const rel = f.relation ?? {};
    const targetModelName = String(rel.model);
    const targetFieldName = String(rel.field);
    const relType = String(rel.type).toLowerCase();

    // disallow naive self-reference for many common relation shapes (unless explicit and allowed)
    if (targetModelName === selfModelName) {
      // conservative policy for now
      throw new ApiError(
        400,
        `Relation '${f.name}' references same model '${selfModelName}'. Self-relations not allowed in this workflow.`
      );
    }

    // Find published target (latest published version)
    const targetVersion = await getLatestPublishedVersionForModelName(
      targetModelName
    );
    if (!targetVersion) {
      throw new ApiError(
        400,
        `Cannot reference unpublished or missing model '${targetModelName}' in relation '${f.name}'. Target model must be published first.`
      );
    }

    // inspect target fields in the snapshot
    const targetFields = fieldsFromDefinition(targetVersion.json ?? {});
    const hasTargetField = targetFields.some(
      (tf: any) => String(tf.name) === targetFieldName
    );
    if (!hasTargetField) {
      throw new ApiError(
        400,
        `Relation '${f.name}' points to ${targetModelName}.${targetFieldName} but that field does not exist in the target model's latest published schema.`
      );
    }

    if (relType === "many-to-many") {
      // many-to-many requires explicit linking model
      throw new ApiError(
        400,
        `Relation '${f.name}' uses 'many-to-many'. Many-to-many relations are not supported automatically — create an explicit linking model and reference it instead.`
      );
    }
  }
}

/**
 * Create a model draft (no ModelVersion created here).
 * Validates relation targets exist & are published.
 */
export async function createModelService(payload: {
  name: string;
  tableName?: string | null;
  json: any;
  ownerField?: string | null;
  createdById?: string | null;
}) {
  validateModelJson(payload.json);

  const existing = await prisma.modelDefinition.findUnique({
    where: { name: payload.name },
  });
  if (existing)
    throw new ApiError(400, `Model with name '${payload.name}' already exists`);

  // Relation validation: ensure referenced models exist and are published, and referenced fields exist.
  const canonical = extractDefinitionFromJson(payload.json);
  await validateRelationTargets(canonical, payload.name);

  const created = await prisma.modelDefinition.create({
    data: {
      name: payload.name,
      tableName: payload.tableName ?? null,
      json: payload.json,
      ownerField: payload.ownerField ?? null,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  });

  await prisma.auditLog.create({
    data: {
      action: "MODEL_CREATE_DRAFT",
      modelId: created.id,
      modelName: created.name,
      details: { createdBy: payload.createdById ?? null },
    },
  });

  return created;
}

/**
 * Update model draft (NO version bump).
 * Validates relations if json provided.
 */
export async function updateModelService(
  id: string,
  payload: {
    json?: any;
    tableName?: string | null;
    ownerField?: string | null;
    updatedById?: string | null;
  }
) {
  const model = await prisma.modelDefinition.findUnique({ where: { id } });
  if (!model) throw new ApiError(404, "Model not found");

  if (payload.json) {
    validateModelJson(payload.json);
    const canonical = extractDefinitionFromJson(payload.json);
    await validateRelationTargets(canonical, model.name);
  }

  const updated = await prisma.modelDefinition.update({
    where: { id },
    data: {
      json: payload.json ?? model.json,
      tableName: payload.tableName ?? model.tableName,
      ownerField: payload.ownerField ?? model.ownerField,
      // IMPORTANT: do NOT change version here (version is last published version)
      updatedAt: new Date(),
    },
  });

  await prisma.auditLog.create({
    data: {
      action: "MODEL_UPDATE_DRAFT",
      modelId: updated.id,
      modelName: updated.name,
      details: { updatedBy: payload.updatedById ?? null },
    },
  });

  return updated;
}

/**
 * Delete model (with optional force cascade).
 * Prevent deletion if other models reference this model (unless force=true).
 * NOTE: system models (isSystem=true) must not be deleted via this API.
 */
export async function deleteModelService(
  id: string,
  opts?: { force?: boolean; deletedById?: string | null }
) {
  const model = await prisma.modelDefinition.findUnique({ where: { id } });
  if (!model) throw new ApiError(404, "Model not found");

  if (model.isSystem) {
    throw new ApiError(403, "Cannot delete a system model");
  }

  // detect references from other modelDefinitions (published or draft). We scan in JS because Prisma JSON queries are limited.
  const allModels = await prisma.modelDefinition.findMany({
    select: { id: true, name: true, json: true, published: true },
  });
  const referencing: Array<{
    modelId: string;
    modelName: string;
    fieldName: string;
  }> = [];
  for (const m of allModels) {
    if (m.id === id) continue;
    const def = extractDefinitionFromJson(m.json);
    if (!Array.isArray(def.fields)) continue;
    for (const f of def.fields) {
      if (
        f &&
        String(f.type).toLowerCase() === "relation" &&
        f.relation &&
        String(f.relation.model) === model.name
      ) {
        referencing.push({
          modelId: m.id,
          modelName: m.name,
          fieldName: f.name,
        });
      }
    }
  }

  if (referencing.length > 0 && !opts?.force) {
    throw new ApiError(
      400,
      `Model '${model.name}' is referenced by other models: ${referencing
        .map((r) => `${r.modelName}.${r.fieldName}`)
        .join(", ")}. Use force=true to delete.`
    );
  }

  const recordCount = await prisma.record.count({ where: { modelId: id } });
  if (recordCount > 0 && !opts?.force) {
    throw new ApiError(
      400,
      "Model has records; use force=true to remove and cascade records"
    );
  }

  await prisma.$transaction(async (tx) => {
    await tx.auditLog.create({
      data: {
        action: "MODEL_DELETE",
        modelId: id,
        modelName: model.name,
        details: { deletedBy: opts?.deletedById ?? null, force: !!opts?.force },
      },
    });

    await tx.modelRolePermission.deleteMany({ where: { modelId: id } });
    // If force, remove related records
    if (opts?.force) {
      await tx.record.deleteMany({ where: { modelId: id } });
      // optionally remove modelVersion rows
      await tx.modelVersion.deleteMany({ where: { modelId: id } });
    }
    await tx.modelDefinition.delete({ where: { id } });
  });

  // best-effort file removal
  try {
    const filename = path.join(MODELS_DIR, `${model.name}.json`);
    if (fs.existsSync(filename)) fs.unlinkSync(filename);
  } catch (e) {
    console.warn("Failed removing model file after delete:", e);
  }

  return { deleted: true };
}

/**
 * Publish model: create a ModelVersion row, update modelDefinition.version, write file, create modelRolePermissions.
 *
 * NOTE: version numbers are derived from existing ModelVersion rows:
 *    newVersion = (latest modelVersion.versionNumber || 0) + 1
 * This ensures the first publish becomes 1.
 *
 * Extra: validate relations at publish time (target must be published + referenced field exist).
 */
export async function publishModelService(
  modelId: string,
  publishedById?: string | null
) {
  ensureModelsDir();

  // fetch current model
  const model = await prisma.modelDefinition.findUnique({
    where: { id: modelId },
  });
  if (!model) throw new ApiError(404, "Model not found");

  if (model.isSystem) {
    // system models are already expected to be final/published via seed
    // but allow re-publish to create a new ModelVersion if needed
  }

  // Safely extract RBAC mapping if json is an object
  let rbacMapping: Record<string, string[]> | null = null;
  if (
    model.json &&
    typeof model.json === "object" &&
    !Array.isArray(model.json)
  ) {
    const jsonObj = model.json as Record<string, any>;
    rbacMapping = (jsonObj.rbac ?? jsonObj.rbacPermissions) || null;
  }

  // Validate relations again (use definition from model.json)
  const canonical = extractDefinitionFromJson(model.json);
  await validateRelationTargets(canonical, model.name);

  const safeName = model.name.replace(/\s+/g, "_");
  const finalPath = path.join(MODELS_DIR, `${safeName}.json`);
  const tempPath = path.join(
    MODELS_DIR,
    `${safeName}.${uuidv4()}${TMP_SUFFIX}`
  );

  let publishedRecord: any = null;

  // Transaction: compute newVersion from existing ModelVersion rows then update modelDefinition + create ModelVersion + modelRolePermissions + audit
  await prisma.$transaction(async (tx) => {
    const txModel = await tx.modelDefinition.findUnique({
      where: { id: modelId },
    });
    if (!txModel) throw new ApiError(404, "Model not found (tx)");

    // compute new version from existing ModelVersion rows (safer)
    const latestVersionRow = await tx.modelVersion.findFirst({
      where: { modelId },
      orderBy: { versionNumber: "desc" },
    });
    const newVersion = (latestVersionRow?.versionNumber ?? 0) + 1;

    // update modelDefinition metadata (published true + bump version)
    const updated = await tx.modelDefinition.update({
      where: { id: modelId },
      data: {
        version: newVersion,
        published: true,
        publishedAt: new Date(),
        publishedById: publishedById ?? null,
        updatedAt: new Date(),
      },
    });

    // Create a ModelVersion entry (snapshot of the model.json being published)
    await tx.modelVersion.create({
      data: {
        modelId: modelId,
        versionNumber: newVersion,
        json: txModel.json ?? {},
        createdById: publishedById ?? null,
        createdAt: new Date(),
      },
    });

    // Replace existing modelRolePermissions for this model
    await tx.modelRolePermission.deleteMany({ where: { modelId } });

    if (rbacMapping && typeof rbacMapping === "object") {
      const permCreate = await tx.permission.findUnique({
        where: { key: "MODEL.CREATE" },
      });
      const permRead = await tx.permission.findUnique({
        where: { key: "MODEL.READ" },
      });
      const permUpdate = await tx.permission.findUnique({
        where: { key: "MODEL.UPDATE" },
      });
      const permDelete = await tx.permission.findUnique({
        where: { key: "MODEL.DELETE" },
      });

      if (!permCreate || !permRead || !permUpdate || !permDelete) {
        throw new ApiError(
          500,
          "Model action permissions not initialized (MODEL.CREATE/READ/UPDATE/DELETE)"
        );
      }

      for (const [roleName, actions] of Object.entries(rbacMapping)) {
        const role = await tx.role.findUnique({ where: { name: roleName } });
        if (!role) continue;

        const normalizedActions = Array.isArray(actions)
          ? (actions as any[]).map((a) => String(a).toUpperCase())
          : [];
        const allowAll = normalizedActions.includes("ALL");
        const toInsert: string[] = [];

        if (allowAll) {
          toInsert.push(
            permCreate.id,
            permRead.id,
            permUpdate.id,
            permDelete.id
          );
        } else {
          if (normalizedActions.includes("CREATE"))
            toInsert.push(permCreate.id);
          if (normalizedActions.includes("READ")) toInsert.push(permRead.id);
          if (normalizedActions.includes("UPDATE"))
            toInsert.push(permUpdate.id);
          if (normalizedActions.includes("DELETE"))
            toInsert.push(permDelete.id);
        }

        for (const pid of toInsert) {
          await tx.modelRolePermission.create({
            data: {
              modelId,
              roleId: role.id,
              permissionId: pid,
              allowed: true,
            },
          });
        }
      }
    }

    // Build file content and write to temp file inside tx callback (so tx aborts if write fails)
    const fileContent = buildModelFileContent({
      id: model.id,
      name: model.name,
      tableName: model.tableName,
      ownerField: model.ownerField,
      version: (latestVersionRow?.versionNumber ?? 0) + 1,
      json: model.json,
    });

    try {
      fs.writeFileSync(tempPath, JSON.stringify(fileContent, null, 2), {
        encoding: "utf8",
        flag: "w",
      });
    } catch (err) {
      throw new ApiError(
        500,
        `Failed to write model file (temp): ${(err as any).message ?? err}`
      );
    }

    await tx.auditLog.create({
      data: {
        action: "MODEL_PUBLISH",
        modelId,
        modelName: model.name,
        details: { publishedBy: publishedById ?? null, tempPath },
      },
    });

    publishedRecord = updated;
    return;
  });

  // Commit done. Move temp -> final
  try {
    if (fs.existsSync(finalPath)) fs.unlinkSync(finalPath);
    fs.renameSync(tempPath, finalPath);
  } catch (err) {
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch {}
    throw new ApiError(
      500,
      `Model published in DB but failed finalizing model file: ${
        (err as any).message ?? err
      }`
    );
  }

  // Update filePath in DB (best-effort)
  try {
    await prisma.modelDefinition.update({
      where: { id: modelId },
      data: { filePath: finalPath, updatedAt: new Date() },
    });
  } catch {
    // ignore
  }

  const full = await prisma.modelDefinition.findUnique({
    where: { id: modelId },
    include: {
      modelRolePermissions: { include: { role: true, permission: true } },
      ModelVersion: true,
    } as any,
  });

  return { published: true, filePath: finalPath, model: full };
}

/**
 * Unpublish model:
 * - mark published=false, remove modelRolePermissions and published file.
 * NOTE: We do NOT bump version here. version represents last published version.
 */
export async function unpublishModelService(
  modelId: string,
  unpublishedById?: string | null
) {
  ensureModelsDir();

  const model = await prisma.modelDefinition.findUnique({
    where: { id: modelId },
  });
  if (!model) throw new ApiError(404, "Model not found");
  if (!model.published) throw new ApiError(400, "Model is not published");

  if (model.isSystem) {
    throw new ApiError(403, "Cannot unpublish a protected system model");
  }

  await prisma.$transaction(async (tx) => {
    const txModel = await tx.modelDefinition.findUnique({
      where: { id: modelId },
    });
    if (!txModel) throw new ApiError(404, "Model not found (tx)");

    await tx.modelDefinition.update({
      where: { id: modelId },
      data: {
        // keep version unchanged (represents last published version)
        published: false,
        publishedAt: null,
        publishedById: null,
        updatedAt: new Date(),
      },
    });

    await tx.modelRolePermission.deleteMany({ where: { modelId } });

    await tx.auditLog.create({
      data: {
        action: "MODEL_UNPUBLISH",
        modelId,
        modelName: txModel.name,
        details: { unpublishedBy: unpublishedById ?? null },
      },
    });

    return;
  });

  // After transaction: attempt to remove the published file (best-effort).
  const safeName = model.name.replace(/\s+/g, "_");
  const finalPath = path.join(MODELS_DIR, `${safeName}.json`);
  let fileRemoved = false;
  try {
    if (fs.existsSync(finalPath)) {
      fs.unlinkSync(finalPath);
      fileRemoved = true;
    }
  } catch (err) {
    console.warn(
      `unpublishModelService: failed to remove file ${finalPath}:`,
      (err as Error).message
    );
  }

  // clear filePath best-effort
  try {
    await prisma.modelDefinition.update({
      where: { id: modelId },
      data: { filePath: null, updatedAt: new Date() },
    });
  } catch (err) {
    console.warn(
      "unpublishModelService: failed to update filePath in DB:",
      (err as Error).message
    );
  }

  const full = await prisma.modelDefinition.findUnique({
    where: { id: modelId },
    include: {
      modelRolePermissions: { include: { role: true, permission: true } },
      ModelVersion: true,
    } as any,
  });

  return { unpublished: true, fileRemoved, filePath: finalPath, model: full };
}

/**
 * List & get helpers
 *
 * listModelsService:
 *  - returns published/drafts (depending on opts) from modelDefinition
 *  - ensures system models (isSystem=true) are included (they are read from DB)
 */
export async function listModelsService(opts?: { onlyPublished?: boolean }) {
  // Build where clause: include published filter for normal models, but always include system models
  const whereNormal: any = {};
  if (opts?.onlyPublished) whereNormal.published = true;

  // Fetch normal (user-created) models (includes system models as well; we'll dedupe)
  const rows = await prisma.modelDefinition.findMany({
    where: whereNormal,
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      tableName: true,
      version: true,
      ownerField: true,
      createdAt: true,
      updatedAt: true,
      json: true,
      published: true,
      filePath: true,
      isSystem: true,
    },
  });

  // Also explicitly fetch system models (in case some system models aren't returned by the above filter)
  const systemWhere: any = { isSystem: true };
  if (opts?.onlyPublished) systemWhere.published = true;
  const systemRows = await prisma.modelDefinition.findMany({
    where: systemWhere,
    orderBy: { name: "asc" },
    select: {
      id: true,
      name: true,
      tableName: true,
      version: true,
      ownerField: true,
      createdAt: true,
      updatedAt: true,
      json: true,
      published: true,
      filePath: true,
      isSystem: true,
    },
  });

  // Merge: prefer DB entries; dedupe by id
  const map = new Map<string, any>();
  for (const r of systemRows) map.set(r.id, r);
  for (const r of rows) map.set(r.id, r);

  return Array.from(map.values());
}

/**
 * Get model by id or name. Supports synthetic names like 'system:user' or 'system:role'
 * and maps them to real model names; if DB entry exists for the system model, prefer it.
 */
export async function getModelService(idOrName: {
  id?: string;
  name?: string;
}) {
  if (!idOrName.id && !idOrName.name)
    throw new ApiError(400, "id or name required");

  // Normalize: if caller passed synthetic 'system:user' or 'system:role', map to real name
  const inputName = idOrName.name ? String(idOrName.name).trim() : undefined;
  if (inputName && inputName.toLowerCase().startsWith(SYSTEM_SENTINEL_PREFIX)) {
    const after = inputName.slice(SYSTEM_SENTINEL_PREFIX.length).toLowerCase();
    if (after === "user" || after === "role") {
      // Try to load from modelDefinition by canonical name
      const canonicalName = after === "user" ? "User" : "Role";
      const row = await prisma.modelDefinition.findUnique({
        where: { name: canonicalName },
        include: {
          modelRolePermissions: { include: { role: true, permission: true } },
          ModelVersion: { orderBy: { versionNumber: "desc" }, take: 10 },
        } as any,
      });
      if (row) return row;

      // fallback synthetic shape (should be rare because seed should create DB rows)
      if (after === "user") {
        return {
          id: `${SYSTEM_SENTINEL_PREFIX}user`,
          name: "User",
          tableName: "users",
          system: true,
          json: { fields: [{ name: "id", type: "string" }, { name: "name", type: "string" }, { name: "email", type: "string" }] },
        };
      }
      if (after === "role") {
        return {
          id: `${SYSTEM_SENTINEL_PREFIX}role`,
          name: "Role",
          tableName: "roles",
          system: true,
          json: { fields: [{ name: "id", type: "string" }, { name: "name", type: "string" }, { name: "description", type: "string" }] },
        };
      }
    }

    // If synthetic but unsupported, fall-through to normal behavior and return not found
  }

  // Normal behavior: use id or name to fetch real modelDefinition
  const where = idOrName.id ? { id: idOrName.id } : { name: idOrName.name };
  const row = await prisma.modelDefinition.findUnique({
    where,
    include: {
      modelRolePermissions: { include: { role: true, permission: true } },
      ModelVersion: { orderBy: { versionNumber: "desc" }, take: 10 },
    } as any,
  });
  if (!row) throw new ApiError(404, "Model not found");
  return row;
}

/**
 * Heuristic to pick a displayField for showing sample labels.
 */
function pickDisplayFieldFromDefinition(defJson: any): string | null {
  const fields = fieldsFromDefinition(defJson);
  if (!fields.length) return null;

  // Prefer common naming conventions for display
  const candidates = ["name", "title", "label", "displayName"];
  for (const key of candidates) {
    if (fields.some((f) => f.name?.toLowerCase() === key)) return key;
  }

  // fallback to first string-type field or just first field
  const stringField = fields.find((f) => f.type?.toLowerCase() === "string");
  return stringField?.name ?? fields[0].name ?? null;
}

/**
 * Return a small curated list of system-level models that are safe/useful to expose as relation targets.
 * Keep this list minimal. Frontend must special-case modelId values that start with SYSTEM_SENTINEL_PREFIX.
 */
const SAFE_SYSTEM_MODELS: Array<{ key: string; name: string }> = [
  { key: "user", name: "User" },
  { key: "role", name: "Role" },
];

/**
 * Build relation suggestions for a given base model (by ID)
 * Returns published models (except the base), their latest version,
 * field metadata, sample records, and counts.
 *
 * NOTE: This function also returns a small curated set of "system" models
 * (e.g. User, Role) when appropriate. System suggestions are marked with modelId
 * prefixed by SYSTEM_SENTINEL_PREFIX so frontend can special-case them if needed.
 */
export async function getRelationSuggestionsService(
  modelId: string,
  opts?: { q?: string; limit?: number; sampleLimit?: number }
) {
  if (!modelId) throw new ApiError(400, "modelId is required");

  const limit = Math.max(1, Math.min(100, Number(opts?.limit ?? 20)));
  const sampleLimit = Math.max(0, Math.min(10, Number(opts?.sampleLimit ?? 3)));
  const q = opts?.q ? String(opts.q).trim().toLowerCase() : null;

  // Verify base model exists
  const baseModel = await prisma.modelDefinition.findUnique({
    where: { id: modelId },
  });
  if (!baseModel)
    throw new ApiError(404, `Base model not found for id: ${modelId}`);

  // Prepare search condition for published models (excluding base model)
  const where: any = {
    published: true,
    id: { not: modelId },
  };

  if (q) {
    where.OR = [
      { name: { contains: q, mode: "insensitive" } },
      { tableName: { contains: q, mode: "insensitive" } },
    ];
  }

  // Fetch all candidate published models
  const publishedModels = await prisma.modelDefinition.findMany({
    where,
    orderBy: { name: "asc" },
    take: limit,
    select: {
      id: true,
      name: true,
      tableName: true,
      json: true,
      version: true,
    },
  });

  // For performance: preload latest versions for all modelIds in one query
  const latestVersions = await prisma.modelVersion.groupBy({
    by: ["modelId"],
    _max: { versionNumber: true },
    where: { modelId: { in: publishedModels.map((m) => m.id) } },
  });

  const versionMap = new Map(latestVersions.map((v) => [v.modelId, v._max.versionNumber]));

  const results: Array<any> = [];

  for (const def of publishedModels) {
    const latestVersionNumber = versionMap.get(def.id);
    const latestVersion =
      latestVersionNumber != null
        ? await prisma.modelVersion.findFirst({
            where: { modelId: def.id, versionNumber: latestVersionNumber },
            select: { json: true, versionNumber: true },
          })
        : null;

    const definitionJson = latestVersion?.json ?? def.json ?? {};
    const displayField = pickDisplayFieldFromDefinition(definitionJson);
    const fields = fieldsFromDefinition(definitionJson).map((f) => ({
      name: f.name,
      type: f.type,
    }));

    if (!fields.some((f) => f.name === "id")) {
      fields.unshift({ name: "id", type: "string" });
    }

    // Record count + sample records (from records table)
    const [count, samples] = await Promise.all([
      prisma.record.count({ where: { modelId: def.id } }),
      prisma.record.findMany({
        where: { modelId: def.id },
        orderBy: { createdAt: "desc" },
        take: sampleLimit,
        select: { id: true, data: true },
      }),
    ]);

    const sampleRecords = samples.map((s) => {
      let label: string | null = null;
      if (displayField && typeof s.data === "object" && s.data !== null) {
        const val = (s.data as any)[displayField];
        if (val !== undefined && val !== null) label = String(val);
      }
      return { id: s.id, label };
    });

    results.push({
      modelId: def.id,
      modelName: def.name,
      tableName: def.tableName,
      versionNumber: latestVersion?.versionNumber ?? def.version,
      displayField,
      fields,
      recordsCount: count,
      sampleRecords,
    });
  }

  // ---------- Curated system model suggestions ----------
  try {
    const baseNameLower = String(baseModel.name ?? "").toLowerCase();

    for (const sys of SAFE_SYSTEM_MODELS) {
      if (baseNameLower === sys.key || baseNameLower === (sys.name ?? "").toLowerCase()) continue;
      // q filter: only include if no query or query matches key/name
      if (q && !sys.key.includes(q) && !(sys.name ?? "").toLowerCase().includes(q)) continue;

      if (sys.key === "user") {
        const [userCount, userSamples] = await Promise.all([
          prisma.user.count(),
          prisma.user.findMany({ orderBy: { createdAt: "desc" }, take: sampleLimit, select: { id: true, name: true, email: true } }),
        ]);
        const userSampleRecords = userSamples.map((u) => ({ id: u.id, label: u.name ?? u.email ?? u.id }));
        const userFields = [
          { name: "id", type: "string" },
          { name: "name", type: "string" },
          { name: "email", type: "string" },
        ];
        results.unshift({
          modelId: `${SYSTEM_SENTINEL_PREFIX}user`,
          modelName: "User",
          tableName: "users",
          versionNumber: 0,
          displayField: userSamples.length && userSamples[0].name ? "name" : "email",
          fields: userFields,
          recordsCount: userCount,
          sampleRecords: userSampleRecords,
        });
      }

      if (sys.key === "role") {
        const [roleCount, roleSamples] = await Promise.all([
          prisma.role.count(),
          prisma.role.findMany({ orderBy: { createdAt: "desc" }, take: sampleLimit, select: { id: true, name: true } }),
        ]);
        const roleSampleRecords = roleSamples.map((r) => ({ id: r.id, label: r.name }));
        const roleFields = [
          { name: "id", type: "string" },
          { name: "name", type: "string" },
        ];
        results.unshift({
          modelId: `${SYSTEM_SENTINEL_PREFIX}role`,
          modelName: "Role",
          tableName: "roles",
          versionNumber: 0,
          displayField: roleSamples.length && roleSamples[0].name ? "name" : "id",
          fields: roleFields,
          recordsCount: roleCount,
          sampleRecords: roleSampleRecords,
        });
      }
    }
  } catch (err) {
    console.warn("system suggestion fetch failed", err);
  }
  // --------------------------------------------------------

  return results;
}
