// src/routes/records.routes.ts
import { Router } from "express";
import { authenticateMiddleware } from "../middleware/auth.middleware";
import { authorize } from "../middleware/rbac.middleware";
import * as recordCtrl from "../controllers/record.controller";

const router = Router();

/**
 * Public pattern:
 * POST   /api/:modelName         -> create (authorize CREATE)
 * GET    /api/:modelName         -> list   (authorize READ)
 * GET    /api/:modelName/:id     -> single (authorize READ)
 * PUT    /api/:modelName/:id     -> update (authorize UPDATE)
 * DELETE /api/:modelName/:id     -> delete (authorize DELETE)
 *
 * Note: authorize() will use req.params.modelName because we do not pass a modelName in options.
 */

router.post("/:modelName", authenticateMiddleware, authorize(), recordCtrl.createRecord);
router.get("/:modelName", authenticateMiddleware, authorize(), recordCtrl.listRecords);
router.get("/:modelName/:id", authenticateMiddleware, authorize(), recordCtrl.getRecord);
router.put("/:modelName/:id", authenticateMiddleware, authorize(), recordCtrl.updateRecord);
router.delete("/:modelName/:id", authenticateMiddleware, authorize(), recordCtrl.deleteRecord);

export default router;
