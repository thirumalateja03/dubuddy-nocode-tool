import { Router } from "express";
import { authenticateMiddleware } from "../middleware/auth.middleware";
import { allowAdminOrFeature } from "../middleware/allowAdminOrFeature.middleware";
import * as modelVersionCtrl from "../controllers/modelVersion.controller";

const router = Router({ mergeParams: true });

// List versions
router.get(
  "/:id/versions",
  authenticateMiddleware,
  allowAdminOrFeature("MANAGE_MODELS"),
  modelVersionCtrl.listVersions
);

// Get specific version by versionNumber
router.get(
  "/:id/versions/:versionNumber",
  authenticateMiddleware,
  allowAdminOrFeature("MANAGE_MODELS"),
  modelVersionCtrl.getVersion
);

// Revert draft to a previous version (creates a new version snapshot / draft)
router.post(
  "/:id/versions/:versionNumber/revert",
  authenticateMiddleware,
  allowAdminOrFeature("MANAGE_MODELS"),
  modelVersionCtrl.revertToVersion
);

// Publish a specific historical version (set model.json -> run publish pipeline)
router.post(
  "/:id/versions/:versionNumber/publish",
  authenticateMiddleware,
  allowAdminOrFeature("PUBLISH_MODEL"),
  modelVersionCtrl.publishVersion
);

export default router;
