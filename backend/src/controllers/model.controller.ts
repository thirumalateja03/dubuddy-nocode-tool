import { Request, Response } from "express";
import { asyncHandler } from "../handlers/asyncHandler";
import { ApiError } from "../handlers/errorHandler";
import * as modelService from "../services/model.service";
import prisma from "../utils/prisma";

/**
 * POST /models/create
 * Body: { name, tableName?, json, ownerField? }
 */
export const createModel = asyncHandler(async (req: Request, res: Response) => {
  const { name, tableName, json, ownerField } = req.body;
  if (!name || !json) throw new ApiError(400, "name and json are required");

  const createdById = (req as any).user?.id ?? null;
  const m = await modelService.createModelService({
    name,
    tableName,
    json,
    ownerField,
    createdById,
  });

  return res.status(201).json({ success: true, model: m });
});

/**
 * PUT /models/:id
 * Body: { json?, tableName?, ownerField? }
 */
export const updateModel = asyncHandler(async (req: Request, res: Response) => {
  const id = String(req.params.id);
  const { json, tableName, ownerField } = req.body;
  if (!json && !tableName && !ownerField)
    throw new ApiError(400, "Nothing to update");

  const updatedById = (req as any).user?.id ?? null;
  // ensure exists
  const model = await prisma.modelDefinition.findUnique({ where: { id } });
  if (!model) throw new ApiError(404, "Model not found");

  const updated = await modelService.updateModelService(id, {
    json,
    tableName,
    ownerField,
    updatedById,
  });
  return res.json({ success: true, model: updated });
});

/**
 * DELETE /models/:id?force=true
 */
export const deleteModel = asyncHandler(async (req: Request, res: Response) => {
  const id = String(req.params.id);
  const force =
    req.query.force === "true" || (req.body && req.body.force === true);
  const deletedById = (req as any).user?.id ?? null;

  await modelService.deleteModelService(id, { force, deletedById });
  return res.json({ success: true, deleted: true });
});

/**
 * POST /models/:id/publish
 */
export const publishModel = asyncHandler(
  async (req: Request, res: Response) => {
    const id = String(req.params.id);
    const publishedById = (req as any).user?.id ?? null;

    const result = await modelService.publishModelService(id, publishedById);
    return res.json({ success: true, ...result });
  }
);

/**
 * POST /models/:id/unpublish
 */
export const unpublishModel = asyncHandler(
  async (req: Request, res: Response) => {
    const id = String(req.params.id);
    const unpublishedById = (req as any).user?.id ?? null;

    const result = await modelService.unpublishModelService(
      id,
      unpublishedById
    );
    return res.json({ success: true, ...result });
  }
);

/**
 * GET /models/all?onlyPublished=true
 */
export const listModels = asyncHandler(async (req: Request, res: Response) => {
  const onlyPublished = String(req.query.onlyPublished || "false") === "true";
  const rows = await modelService.listModelsService({ onlyPublished });
  return res.json({ success: true, models: rows });
});

/**
 * GET /models/:id
 */
export const getModel = asyncHandler(async (req: Request, res: Response) => {
  const idOrName = String(
    req.params.id || req.query.id || req.query.name || ""
  );
  if (!idOrName)
    throw new ApiError(400, "id or name required (as param or query)");
  const isUUID = idOrName.includes("-");
  const model = await modelService.getModelService(
    isUUID ? { id: idOrName } : { name: idOrName }
  );
  return res.json({ success: true, model });
});

export const getRelationSuggestions = asyncHandler(
  async (req: Request, res: Response) => {
    const id = String(req.params.id ?? "").trim();
    const q = req.query.q ? String(req.query.q) : undefined;
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    const sampleLimit = req.query.sampleLimit
      ? Number(req.query.sampleLimit)
      : undefined;

    const suggestions = await modelService.getRelationSuggestionsService(
      id,
      { q, limit, sampleLimit }
    );
    return res.json({ success: true, suggestions });
  }
);
