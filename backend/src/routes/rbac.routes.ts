import { Router } from "express";
import * as rbacController from "../controllers/rbac.controller";
import { authenticateMiddleware } from "../middleware/auth.middleware";
import { allowAdminOrFeature } from "../middleware/allowAdminOrFeature.middleware";

const router = Router();

// Role management: Admin or CREATE_ROLE feature
router.post(
  "/roles",
  authenticateMiddleware,
  allowAdminOrFeature("CREATE_ROLE"),
  rbacController.createRole
);
router.get(
  "/roles",
  authenticateMiddleware,
  allowAdminOrFeature("MANAGE_FEATURES"),
  rbacController.listRoles
);

router.get("/models/merged", authenticateMiddleware, rbacController.mergedModelPermissions);

// Model role-permission upsert: Admin or MANAGE_MODELS / PUBLISH_MODEL depending on workflow
router.post(
  "/models/permissions",
  authenticateMiddleware,
  allowAdminOrFeature("MANAGE_MODELS"),
  rbacController.upsertModelPermissions
);
router.get(
  "/models/permissions",
  authenticateMiddleware,
  allowAdminOrFeature("MANAGE_MODELS"),
  rbacController.getModelPermissions
);

// Feature grants (role/user): require MANAGE_FEATURES or Admin
router.post(
  "/grant/role",
  authenticateMiddleware,
  allowAdminOrFeature("MANAGE_FEATURES"),
  rbacController.roleGrant
);
router.post(
  "/grant/user",
  authenticateMiddleware,
  allowAdminOrFeature("MANAGE_FEATURES"),
  rbacController.userGrant
);

// Lists for UI
router.get(
  "/grant/role/list",
  authenticateMiddleware,
  allowAdminOrFeature("MANAGE_FEATURES"),
  rbacController.roleList
);
router.get(
  "/grant/user/list",
  authenticateMiddleware,
  allowAdminOrFeature("MANAGE_FEATURES"),
  rbacController.userList
);

router.get(
  "/grant/user/merged",
  authenticateMiddleware,
  allowAdminOrFeature("MANAGE_FEATURES"),
  rbacController.mergedPermissionList
);

export default router;
