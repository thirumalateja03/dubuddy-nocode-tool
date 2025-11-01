// src/middleware/rbac.middleware.ts
import { Request, Response, NextFunction } from "express";
import { ApiError } from "../handlers/errorHandler";
import prisma from "../utils/prisma";
import { roleHasPermissionForModel, getModelDefinitionByName } from "../services/rbac.service";

/**
 * Action map
 */
export type RBACAction = "CREATE" | "READ" | "UPDATE" | "DELETE";

function methodToAction(method: string): RBACAction | null {
  switch (method.toUpperCase()) {
    case "POST":
      return "CREATE";
    case "GET":
      return "READ";
    case "PUT":
    case "PATCH":
      return "UPDATE";
    case "DELETE":
      return "DELETE";
    default:
      return null;
  }
}

export function authorize(opts?: { modelName?: string; action?: RBACAction }) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as any).user;
      if (!user || !user.id) return next(new ApiError(401, "Authentication required"));

      const modelName = opts?.modelName ?? (req.params && (req.params as any).modelName);
      if (!modelName) return next(new ApiError(400, "Model name required in route or options"));

      const action = opts?.action ?? methodToAction(req.method);
      if (!action) return next(new ApiError(400, "Unable to determine action for authorization"));

      const modelDef = await getModelDefinitionByName(modelName);
      if (!modelDef) return next(new ApiError(404, `Model not found: ${modelName}`));
      const modelId = modelDef.id;

      // try role from JWT first
      const roleName = (req as any).user.role;
      let role = null;
      if (roleName) role = await prisma.role.findUnique({ where: { name: roleName } });

      // fallback to DB lookup for the user
      if (!role) {
        const u = await prisma.user.findUnique({ where: { id: String((req as any).user.id) }, include: { role: true } });
        role = u?.role ?? null;
      }
      if (!role) return next(new ApiError(403, "User role not assigned"));

      // check role permission for model action
      const allowed = await roleHasPermissionForModel(role.id, modelId, action as any);
      if (allowed) return next();

      // ownership fallback for UPDATE/DELETE/READ
      const ownerField = modelDef.ownerField ?? null;
      if (ownerField && (action === "UPDATE" || action === "DELETE" || action === "READ")) {
        const recordId = (req.params as any).id ?? (req.body && req.body.id) ?? null;
        if (!recordId) {
          return next(new ApiError(403, "No record identifier provided for ownership check"));
        }

        const record = await prisma.record.findUnique({ where: { id: String(recordId) } });
        if (!record) return next(new ApiError(404, "Record not found"));

        if (record.ownerId && String(record.ownerId) === String((req as any).user.id)) {
          return next();
        }

        try {
          const dataObj = record.data as any;
          if (dataObj && dataObj[ownerField] && String(dataObj[ownerField]) === String((req as any).user.id)) {
            return next();
          }
        } catch {
          // ignore
        }
      }

      return next(new ApiError(403, "Forbidden: you do not have permission for this action"));
    } catch (err) {
      return next(err);
    }
  };
}
