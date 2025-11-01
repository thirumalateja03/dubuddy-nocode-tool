// src/middleware/feature.middleware.ts
import { Request, Response, NextFunction } from "express";
import { ApiError } from "../handlers/errorHandler";
import { checkFeatureAllowed } from "../services/featurePermission.service";

/**
 * requireFeature("CREATE_ROLE")
 * - requires authenticateMiddleware to have run and set req.user
 */
export function requireFeature(feature: string) {
  return async (req: any, res: Response, next: NextFunction) => {
    try {
      const user = req.user;
      if (!user || !user.id) return next(new ApiError(401, "Authentication required"));

      const ok = await checkFeatureAllowed(String(user.id), feature);
      if (!ok) return next(new ApiError(403, `Feature ${feature} not permitted`));
      return next();
    } catch (err) {
      return next(err);
    }
  };
}
