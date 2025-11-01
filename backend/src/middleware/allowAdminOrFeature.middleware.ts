import { Request, Response, NextFunction } from "express";
import { ApiError } from "../handlers/errorHandler";
import { requireFeature } from "./feature.middleware";

/**
 * Allow Admin (fast path) OR a user with the provided feature permission.
 * Usage: router.post('/', authenticateMiddleware, allowAdminOrFeature('CREATE_USER'), handler)
 */
export function allowAdminOrFeature(feature: string) {
  return async (req: any, res: Response, next: NextFunction) => {
    try {
      const role = req.user?.role;
      if (!req.user || !req.user.id)
        return next(new ApiError(401, "Authentication required"));

      // Fast path for Admin by token role
      if (role === "Admin") return next();

      // Fallback to feature-permission check
      return requireFeature(feature)(req, res, next);
    } catch (err) {
      return next(err);
    }
  };
}
