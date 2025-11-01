import { Router } from "express";
import * as modelCtrl from "../controllers/model.controller";
import { authenticateMiddleware } from "../middleware/auth.middleware";
import { allowAdminOrFeature } from "../middleware/allowAdminOrFeature.middleware";


const router = Router();


/**
* Model CRUD and publish endpoints
* - Create/Update/Delete: Admin OR MANAGE_MODELS
* - Publish: Admin OR PUBLISH_MODEL (publishing writes /models/*.json and registers runtime routes)
* - Read (list/fetch): Admin OR MANAGE_MODELS OR MODEL.READ (if you prefer granular access)
*/


// Create a model draft
router.post("/create", authenticateMiddleware, allowAdminOrFeature("MANAGE_MODELS"), modelCtrl.createModel);


// Update a model (by id)
router.put("/:id", authenticateMiddleware, allowAdminOrFeature("MANAGE_MODELS"), modelCtrl.updateModel);


// Delete a model
router.delete("/:id", authenticateMiddleware, allowAdminOrFeature("MANAGE_MODELS"), modelCtrl.deleteModel);


// Publish a model (writes file + marks published)
router.post("/:id/publish", authenticateMiddleware, allowAdminOrFeature("PUBLISH_MODEL"), modelCtrl.publishModel);

// Unpublish a model (take offline but keep model draft)
router.post("/:id/unpublish", authenticateMiddleware, allowAdminOrFeature("PUBLISH_MODEL"), modelCtrl.unpublishModel);

// List & get
router.get("/all", authenticateMiddleware, allowAdminOrFeature("MANAGE_MODELS"), modelCtrl.listModels);
router.get("/:id", authenticateMiddleware, allowAdminOrFeature("MANAGE_MODELS"), modelCtrl.getModel);

router.get(
  "/:id/relation-suggestions",
  authenticateMiddleware,
  allowAdminOrFeature("MANAGE_MODELS"), // or a less strict permission if you want editors to use it
  modelCtrl.getRelationSuggestions
);


export default router;