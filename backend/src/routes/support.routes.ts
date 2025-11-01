import { Router } from "express";
import { authenticateMiddleware } from "../middleware/auth.middleware";
import { allowAdminOrFeature } from "../middleware/allowAdminOrFeature.middleware";
import * as supportCtrl from "../controllers/support.controller";

const router = Router();

/**
 * Support endpoints - secured: Admin OR VIEW_SUPPORT feature
 */
router.get(
  "/stats",
  authenticateMiddleware,
  allowAdminOrFeature("VIEW_SUPPORT"),
  supportCtrl.getStats
);

router.get(
  "/audit",
  authenticateMiddleware,
  allowAdminOrFeature("VIEW_SUPPORT"),
  supportCtrl.getAuditLogs
);

export default router;
