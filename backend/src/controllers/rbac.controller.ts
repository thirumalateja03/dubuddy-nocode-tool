// src/controllers/rbac.controller.ts
import { Request, Response } from "express";
import { asyncHandler } from "../handlers/asyncHandler";
import { ApiError } from "../handlers/errorHandler";
import * as rbacService from "../services/rbac.service";
import prisma from "../utils/prisma";
import {
  upsertRolePermission,
  upsertUserPermission,
  listRolePermissions,
  listUserPermissions,
  getMergedPermissionsForUser,
  checkFeatureAllowed,
} from "../services/featurePermission.service";

/** Create role (Admin only) */
export const createRole = asyncHandler(async (req: Request, res: Response) => {
  const { name, description, isSystem } = req.body;
  if (!name) throw new ApiError(400, "Role name required");
  const role = await rbacService.createRole({ name, description, isSystem });
  res.status(201).json({ success: true, role });
});

export const listRoles = asyncHandler(async (_req: Request, res: Response) => {
  const roles = await rbacService.listRoles();
  res.json({ success: true, roles });
});

/**
 * Upsert model-role permissions.
 * Body: { modelName, roleName, permissions: ["CREATE","READ"] }
 */
export const upsertModelPermissions = asyncHandler(
  async (req: Request, res: Response) => {
    const { modelName, roleName, permissions } = req.body;
    if (!modelName || !roleName || !permissions)
      throw new ApiError(400, "modelName, roleName, permissions required");

    const model = await prisma.modelDefinition.findUnique({
      where: { name: modelName },
    });
    if (!model) throw new ApiError(404, "Model not found");

    const role = await prisma.role.findUnique({ where: { name: roleName } });
    if (!role) throw new ApiError(404, "Role not found");

    const m = await rbacService.upsertModelRolePermission(
      model.id,
      role.id,
      permissions
    );
    res.json({ success: true, result: m });
  }
);

/** Get permissions for a model (per role) */
export const getModelPermissions = asyncHandler(
  async (req: Request, res: Response) => {
    const modelName = String(req.query.modelName || "");
    if (!modelName) throw new ApiError(400, "modelName query param required");
    const model = await prisma.modelDefinition.findUnique({
      where: { name: modelName },
    });
    if (!model) throw new ApiError(404, "Model not found");

    const perms = await prisma.modelRolePermission.findMany({
      where: { modelId: model.id },
      include: { role: true, permission: true },
    });
    res.json({ success: true, permissions: perms });
  }
);

export const roleGrant = asyncHandler(async (req: Request, res: Response) => {
  const { roleName, feature, granted } = req.body;
  if (!roleName || !feature)
    throw new ApiError(400, "roleName and feature required");
  const row = await upsertRolePermission(
    roleName,
    feature,
    granted === undefined ? true : Boolean(granted)
  );
  res.json({ success: true, row });
});

export const userGrant = asyncHandler(async (req: Request, res: Response) => {
  const { userId, feature, granted } = req.body;
  if (!userId || !feature)
    throw new ApiError(400, "userId and feature required");
  const row = await upsertUserPermission(
    String(userId),
    feature,
    granted === undefined ? true : Boolean(granted)
  );
  res.json({ success: true, row });
});

export const roleList = asyncHandler(async (req: Request, res: Response) => {
  const roleName = String(req.query.roleName || "");
  if (!roleName) throw new ApiError(400, "roleName query param required");
  const rows = await listRolePermissions(roleName);
  res.json({ success: true, permissions: rows });
});

export const userList = asyncHandler(async (req: Request, res: Response) => {
  const userId = String(req.query.userId || "");
  if (!userId) throw new ApiError(400, "userId query param required");
  const rows = await listUserPermissions(userId);
  res.json({ success: true, permissions: rows });
});

export const mergedPermissionList = asyncHandler(
  async (req: Request, res: Response) => {
    const userId = String(req.query.userId || "");
    if (!userId) throw new ApiError(400, "userId query param required");

    const mergedPermissions = await getMergedPermissionsForUser(userId);

    res.json({
      success: true,
      count: mergedPermissions.length,
      permissions: mergedPermissions,
    });
  }
);

/**
 * GET /rbac/models/merged?userId=<id>&includeUnpublished=<true|false>
 *
 * - If userId === requester -> allowed.
 * - If requester is Admin or has MANAGE_FEATURES -> allowed for any userId.
 * - includeUnpublished (optional) - Admins can set true to include unpublished models; default false.
 */
export const mergedModelPermissions = asyncHandler(
  async (req: Request, res: Response) => {
    const requestedUserId = String(req.query.userId || "");
    if (!requestedUserId)
      throw new ApiError(400, "userId query param required");

    const requester = (req as any).user;
    if (!requester || !requester.id)
      throw new ApiError(401, "Authentication required");

    const requesterId = String(requester.id);
    const requesterRoleName = requester.role ?? null;

    // If requesting for another user, require admin or MANAGE_FEATURES
    if (requestedUserId !== requesterId) {
      // Admin shortcut
      if (requesterRoleName !== "Admin") {
        const ok = await checkFeatureAllowed(requesterId, "MANAGE_FEATURES");
        if (!ok)
          throw new ApiError(
            403,
            "Forbidden: cannot view other user's model permissions"
          );
      }
    }

    const includeUnpublished =
      String(req.query.includeUnpublished || "false") === "true";

    const perms = await rbacService.getMergedModelPermissionsForUser(
      requestedUserId,
      includeUnpublished
    );
    res.json({ success: true, count: perms.length, permissions: perms });
  }
);
