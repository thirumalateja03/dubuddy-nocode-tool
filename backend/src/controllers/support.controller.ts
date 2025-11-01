import { Request, Response } from "express";
import { asyncHandler } from "../handlers/asyncHandler";
import * as supportService from "../services/support.service";

/**
 * GET /support/stats
 */
export const getStats = asyncHandler(async (_req: Request, res: Response) => {
  const stats = await supportService.getSupportStats();
  return res.json({ success: true, stats });
});

/**
 * GET /support/audit?limit=10
 */
export const getAuditLogs = asyncHandler(async (req: Request, res: Response) => {
  const rawLimit = Number(req.query.limit ?? 10);
  const limit = Number.isInteger(rawLimit) ? rawLimit : 10;
  const logs = await supportService.getAuditLogs(Math.min(Math.max(limit, 1), 100)); // clamp 1..100
  return res.json({ success: true, count: logs.length, logs });
});
