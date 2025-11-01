// src/utils/asyncHandler.ts
import { Request, Response, NextFunction } from "express";

/**
 * Wraps async route handlers and forwards errors to global handler.
 * Usage:
 *   router.get('/route', asyncHandler(controllerFn));
 */
export const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<any>) =>
  (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
