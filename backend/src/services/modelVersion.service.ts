// src/services/modelVersion.service.ts
import prisma from "../utils/prisma";
import { ApiError } from "../handlers/errorHandler";
import * as modelService from "./model.service";

/**
 * Helpers: canonical extraction / fields
 */
function extractDefinitionFromJson(json: any): any {
  if (!json || typeof json !== "object" || Array.isArray(json)) return {};
  return (json.definition ?? json) as Record<string, any>;
}
function fieldsFromDefinition(json: any): any[] {
  const def = extractDefinitionFromJson(json);
  return Array.isArray(def.fields) ? def.fields : [];
}

/**
 * Resolve canonical fields for a target model name.
 * Priority:
 *   1. latest published ModelVersion.json (if exists)
 *   2. modelDefinition.json (useful for system models seeded into modelDefinition)
 * Returns an array of field descriptors or null if none found.
 */
async function resolveFieldsForTargetModel(targetModelName: string): Promise<any[] | null> {
  // find the modelDefinition first
  const targetModel = await prisma.modelDefinition.findFirst({
    where: { OR: [{ name: targetModelName }, { tableName: targetModelName }] },
  });

  // try latest published ModelVersion first (preferred)
  if (targetModel) {
    const latestVersion = await prisma.modelVersion.findFirst({
      where: { modelId: targetModel.id },
      orderBy: { versionNumber: "desc" },
    });
    if (latestVersion && latestVersion.json) {
      const f = fieldsFromDefinition(latestVersion.json ?? {});
      if (Array.isArray(f) && f.length) return f;
    }

    // fallback to modelDefinition.json (especially helpful for system models)
    if (targetModel.json) {
      const f = fieldsFromDefinition(targetModel.json ?? {});
      if (Array.isArray(f) && f.length) return f;
    }
  }

  // last-resort: for very common built-in system targets, attempt to read directly from DB shapes
  const lower = String(targetModelName).toLowerCase();
  if (lower === "user") {
    return [
      { name: "id", type: "string" },
      { name: "name", type: "string" },
      { name: "email", type: "string" },
    ];
  }
  if (lower === "role") {
    return [
      { name: "id", type: "string" },
      { name: "name", type: "string" },
      { name: "description", type: "string" },
    ];
  }

  return null;
}

/**
 * Validate relation entries inside a snapshot JSON.
 * - ensures referenced target model exists (or is an allowed system model)
 * - ensures target's latest published snapshot OR modelDefinition contains referenced field
 * - disallows many-to-many (explicit linking model required)
 * - disallows straightforward self-reference (conservative)
 */
export async function validateRelationsInSnapshot(snapshotJson: any, selfModelName: string) {
  const fields = fieldsFromDefinition(snapshotJson);
  if (!Array.isArray(fields)) return;

  for (const f of fields) {
    if (!f || String(f.type).toLowerCase() !== "relation") continue;
    const rel = f.relation ?? {};
    const targetModelName = String(rel.model || "");
    const targetFieldName = String(rel.field || "");
    const relType = String(rel.type || "").toLowerCase();

    if (!targetModelName) {
      throw new ApiError(400, `Relation '${f.name}' missing relation.model`);
    }
    if (!targetFieldName) {
      throw new ApiError(400, `Relation '${f.name}' missing relation.field`);
    }
    if (!relType) {
      throw new ApiError(400, `Relation '${f.name}' missing relation.type`);
    }

    const allowed = new Set(["one-to-one", "one-to-many", "many-to-one", "many-to-many"]);
    if (!allowed.has(relType)) {
      throw new ApiError(
        400,
        `Relation '${f.name}' has unsupported relation.type '${rel.type}'. Allowed: ${Array.from(allowed).join(", ")}`
      );
    }

    // conservative: do not allow simple self-references
    if (targetModelName === selfModelName) {
      throw new ApiError(400, `Relation '${f.name}' references same model '${selfModelName}'. Self-relations not allowed.`);
    }

    // ensure target exists or is a safe system target
    const targetModel = await prisma.modelDefinition.findFirst({
      where: { OR: [{ name: targetModelName }, { tableName: targetModelName }] },
    });

    if (!targetModel) {
      // allow system fallback for very common targets (user/role) — but prefer modelDefinition existence
      const lower = targetModelName.toLowerCase();
      if (lower !== "user" && lower !== "role") {
        throw new ApiError(400, `Relation '${f.name}' references missing model '${targetModelName}'.`);
      }
      // else continue — resolveFieldsForTargetModel will provide fallback fields
    } else {
      // If targetModel exists but is not published and not system, we require it to be published
      if (!targetModel.published && !targetModel.isSystem) {
        throw new ApiError(400, `Relation '${f.name}' references model '${targetModelName}' which is not published.`);
      }
    }

    // Resolve actual fields from latest snapshot or modelDefinition (system models will be resolved)
    const targetFields = await resolveFieldsForTargetModel(targetModelName);
    if (!targetFields || !Array.isArray(targetFields)) {
      throw new ApiError(
        400,
        `Relation '${f.name}' references model '${targetModelName}' but couldn't resolve its schema fields. Ensure the target model is published or seeded as a system model.`
      );
    }

    const found = targetFields.some((tf: any) => String(tf.name) === targetFieldName);
    if (!found) {
      throw new ApiError(
        400,
        `Relation '${f.name}' points to ${targetModelName}.${targetFieldName} but that field does not exist in the target model's latest snapshot/definition.`
      );
    }

    // disallow many-to-many auto wiring. Recommend explicit linking model.
    if (relType === "many-to-many") {
      throw new ApiError(
        400,
        `Relation '${f.name}' uses 'many-to-many'. This workflow requires an explicit linking model — create a linking model and reference it instead.`
      );
    }
  }
}

/**
 * List model versions (published snapshots)
 */
export async function listModelVersions(modelId: string, opts?: { limit?: number }) {
  if (!modelId) throw new ApiError(400, "modelId required");
  const model = await prisma.modelDefinition.findUnique({ where: { id: modelId } });
  if (!model) throw new ApiError(404, "Model not found");

  // Allow listing versions for system models too — they might have been created by seed.
  const rows = await prisma.modelVersion.findMany({
    where: { modelId },
    orderBy: { versionNumber: "desc" },
    take: opts?.limit ?? 20,
    include: { createdBy: { select: { id: true, name: true, email: true } } },
  });

  return rows;
}

/**
 * Get single ModelVersion by number
 */
export async function getModelVersion(modelId: string, versionNumber: number) {
  if (!modelId) throw new ApiError(400, "modelId required");
  if (!Number.isInteger(versionNumber)) throw new ApiError(400, "versionNumber required");

  const v = await prisma.modelVersion.findUnique({
    where: { modelId_versionNumber: { modelId, versionNumber } },
    include: { createdBy: { select: { id: true, name: true, email: true } } },
  });

  if (!v) throw new ApiError(404, "Model version not found");
  return v;
}

/**
 * Revert model draft to a chosen version:
 * - validates relations inside the target snapshot (targets must be published OR system)
 * - updates modelDefinition.json to the selected snapshot (draft)
 * - does NOT create a new published ModelVersion (versions are created on publish only)
 * - writes an audit log
 *
 * Returns the updated modelDefinition.
 *
 * NOTE: system models are protected — disallow reverting system models via this API.
 */
export async function revertModelToVersion(
  modelId: string,
  versionNumber: number,
  performedById?: string | null,
  opts?: { message?: string | null }
) {
  if (!modelId) throw new ApiError(400, "modelId required");
  if (!Number.isInteger(versionNumber)) throw new ApiError(400, "versionNumber required");

  const target = await prisma.modelVersion.findUnique({
    where: { modelId_versionNumber: { modelId, versionNumber } },
  });
  if (!target) throw new ApiError(404, "Target model version not found");

  const model = await prisma.modelDefinition.findUnique({ where: { id: modelId } });
  if (!model) throw new ApiError(404, "Model not found");

  if (model.isSystem) {
    // Protect system models from structural revert
    throw new ApiError(403, "Cannot revert a protected system model's definition");
  }

  // Validate relations within the target snapshot: any relation should reference a published model or a system model
  await validateRelationsInSnapshot(target.json ?? {}, model.name);

  // Update modelDefinition.json to target snapshot (this becomes a draft)
  const updated = await prisma.modelDefinition.update({
    where: { id: modelId },
    data: {
      json: target.json ?? {},
      updatedAt: new Date(),
      // keep published/version unchanged here (revert creates a draft)
    },
  });

  await prisma.auditLog.create({
    data: {
      userId: performedById ?? null,
      action: "MODEL_REVERT",
      modelId,
      modelName: model.name,
      details: { restoredFrom: versionNumber, message: opts?.message ?? null },
    },
  });

  const full = await prisma.modelDefinition.findUnique({
    where: { id: modelId },
    include: { ModelVersion: { orderBy: { versionNumber: "desc" }, take: 10 } } as any,
  });

  return full;
}

/**
 * Publish a historical version:
 *  - validate relations in the historical snapshot
 *  - set modelDefinition.json to target snapshot (draft)
 *  - call modelService.publishModelService which will create a new ModelVersion and write file.
 *
 * Returns result of publishModelService.
 *
 * NOTE: publishing a historical version for a protected system model is disallowed.
 */
export async function publishModelVersion(modelId: string, versionNumber: number, performedById?: string | null) {
  if (!modelId) throw new ApiError(400, "modelId required");
  if (!Number.isInteger(versionNumber)) throw new ApiError(400, "versionNumber required");

  const target = await prisma.modelVersion.findUnique({
    where: { modelId_versionNumber: { modelId, versionNumber } },
  });
  if (!target) throw new ApiError(404, "Target model version not found");

  const model = await prisma.modelDefinition.findUnique({ where: { id: modelId } });
  if (!model) throw new ApiError(404, "Model not found");

  if (model.isSystem) {
    // Protect system models — publishing structural changes should be controlled via seed/migrations only.
    throw new ApiError(403, "Cannot publish a version for a protected system model");
  }

  // Validate relations in the historical snapshot before touching DB
  await validateRelationsInSnapshot(target.json ?? {}, model.name);

  // Update modelDefinition.json to the target snapshot (draft)
  await prisma.modelDefinition.update({
    where: { id: modelId },
    data: {
      json: target.json ?? {},
      updatedAt: new Date(),
    },
  });

  // Now call the publish pipeline (it will validate relations again and create new ModelVersion)
  const published = await modelService.publishModelService(modelId, performedById ?? null);

  return published;
}
