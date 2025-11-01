import { Request, Response } from "express";
import { asyncHandler } from "../handlers/asyncHandler";
import { ApiError } from "../handlers/errorHandler";
import * as recordService from "../services/record.service";

/**
 * POST /api/:modelName
 */
export const createRecord = asyncHandler(async (req: Request, res: Response) => {
  const modelName = String(req.params.modelName || "");
  if (!modelName) throw new ApiError(400, "modelName required in path");
  const payload = req.body ?? {};
  const actingUserId = (req as any).user?.id ?? null;
  const rec = await recordService.createRecordService(modelName, payload, actingUserId);
  res.status(201).json({ success: true, record: rec });
});

/**
 * GET /api/:modelName
 */
export const listRecords = asyncHandler(async (req: Request, res: Response) => {
  const modelName = String(req.params.modelName || "");
  const limit = Number(req.query.limit ?? 20);
  const skip = Number(req.query.skip ?? 0);
  const ownerOnly = String(req.query.ownerOnly ?? "false") === "true";
  const actingUserId = (req as any).user?.id ?? null;

  const result = await recordService.listRecordsService(modelName, {
    limit,
    skip,
    ownerOnly,
    userId: actingUserId,
  });

  res.json({ success: true, total: result.total, items: result.items });
});

/**
 * GET /api/:modelName/:id
 */
export const getRecord = asyncHandler(async (req: Request, res: Response) => {
  const modelName = String(req.params.modelName || "");
  const id = String(req.params.id || "");
  if (!modelName || !id) throw new ApiError(400, "modelName and id required");
  const rec = await recordService.getRecordService(modelName, id);
  res.json({ success: true, record: rec });
});

/**
 * PUT /api/:modelName/:id
 */
export const updateRecord = asyncHandler(async (req: Request, res: Response) => {
  const modelName = String(req.params.modelName || "");
  const id = String(req.params.id || "");
  if (!modelName || !id) throw new ApiError(400, "modelName and id required");
  const payload = req.body ?? {};
  const actingUserId = (req as any).user?.id ?? null;
  const updated = await recordService.updateRecordService(modelName, id, payload, actingUserId);
  res.json({ success: true, record: updated });
});

/**
 * DELETE /api/:modelName/:id
 */
export const deleteRecord = asyncHandler(async (req: Request, res: Response) => {
  const modelName = String(req.params.modelName || "");
  const id = String(req.params.id || "");
  if (!modelName || !id) throw new ApiError(400, "modelName and id required");
  const actingUserId = (req as any).user?.id ?? null;
  await recordService.deleteRecordService(modelName, id, actingUserId);
  res.json({ success: true, deleted: true });
});
