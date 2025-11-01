import { Request, Response } from "express";
import { asyncHandler } from "../handlers/asyncHandler";
import { ApiError } from "../handlers/errorHandler";
import * as modelVersionService from "../services/modelVersion.service";

/**
 * GET /models/:id/versions?limit=10
 */
export const listVersions = asyncHandler(async (req: Request, res: Response) => {
  const modelId = String(req.params.id || req.query.id || "");
  if (!modelId) throw new ApiError(400, "model id required");
  const limit = Math.max(1, Math.min(100, Number(req.query.limit ?? 10)));
  const rows = await modelVersionService.listModelVersions(modelId, { limit });
  return res.json({ success: true, count: rows.length, versions: rows });
});

/**
 * GET /models/:id/versions/:versionNumber
 */
export const getVersion = asyncHandler(async (req: Request, res: Response) => {
  const modelId = String(req.params.id || "");
  const versionNumber = Number(req.params.versionNumber);
  if (!modelId) throw new ApiError(400, "model id required");
  if (!Number.isInteger(versionNumber) || versionNumber < 1)
    throw new ApiError(400, "valid versionNumber required");

  const v = await modelVersionService.getModelVersion(modelId, versionNumber);
  return res.json({ success: true, version: v });
});

/**
 * POST /models/:id/versions/:versionNumber/revert
 * body optional: { message?: string }
 */
export const revertToVersion = asyncHandler(async (req: Request, res: Response) => {
  const modelId = String(req.params.id || "");
  const versionNumber = Number(req.params.versionNumber);
  if (!modelId) throw new ApiError(400, "model id required");
  if (!Number.isInteger(versionNumber) || versionNumber < 1)
    throw new ApiError(400, "valid versionNumber required");

  const performedById = (req as any).user?.id ?? null;
  const result = await modelVersionService.revertModelToVersion(modelId, versionNumber, performedById, {
    message: req.body?.message ?? null,
  });

  return res.json({ success: true, reverted: true, model: result });
});

/**
 * POST /models/:id/versions/:versionNumber/publish
 * Publishes the specified snapshot (will be the content of the published file)
 */
export const publishVersion = asyncHandler(async (req: Request, res: Response) => {
  const modelId = String(req.params.id || "");
  const versionNumber = Number(req.params.versionNumber);
  if (!modelId) throw new ApiError(400, "model id required");
  if (!Number.isInteger(versionNumber) || versionNumber < 1)
    throw new ApiError(400, "valid versionNumber required");

  const performedById = (req as any).user?.id ?? null;
  const result = await modelVersionService.publishModelVersion(modelId, versionNumber, performedById);
  return res.json({ success: true, ...result });
});
