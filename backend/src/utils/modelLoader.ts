import fs from "fs";
import path from "path";
import express, { Application, Router, Request, Response, NextFunction } from "express";
import chokidar, { FSWatcher } from "chokidar"; //import correctly
import { v4 as uuidv4 } from "uuid";

import { asyncHandler } from "../handlers/asyncHandler";
import { authenticateMiddleware } from "../middleware/auth.middleware";
import { authorize } from "../middleware/rbac.middleware";
import * as recordService from "../services/record.service";

/**
 * Model file shape expected on disk (published file)
 * { id, name, tableName, ownerField, version, publishedAt, definition: { fields: [...] } }
 */

const MODELS_DIR = process.env.MODELS_DIR ?? path.resolve(process.cwd(), "models");
const FILE_GLOB = path.join(MODELS_DIR, "*.json");
const WATCH_DEBOUNCE_MS = Number(process.env.MODEL_WATCH_DEBOUNCE_MS ?? 250);

/**
 * Internal state for live dynamic router management.
 */
let currentRouter: Router = express.Router();
let parentRouter: Router | null = null;
let watcher: FSWatcher | null = null;
let lastReloadToken = "";

/** Ensure models directory exists */
function ensureModelsDir(): void {
  if (!fs.existsSync(MODELS_DIR)) fs.mkdirSync(MODELS_DIR, { recursive: true });
}

/**
 * Build an express Router dynamically from model JSON files
 */
export async function buildDynamicRouter(): Promise<Router> {
  ensureModelsDir();
  const router = express.Router();

  const files = fs.readdirSync(MODELS_DIR).filter((f) => f.endsWith(".json"));

  for (const fname of files) {
    const filePath = path.join(MODELS_DIR, fname);
    try {
      const raw = fs.readFileSync(filePath, "utf8");
      const parsed = JSON.parse(raw);

      if (!parsed || typeof parsed !== "object" || !parsed.name) {
        console.warn(`[modelLoader] skipping invalid model file ${fname}`);
        continue;
      }

      const modelName: string = String(parsed.name);
      const routeName = (parsed.tableName && String(parsed.tableName).trim()) || modelName;
      const lowerName = String(routeName).toLowerCase();

      const r = Router();

      /** Create */
      r.post(
        "/",
        authenticateMiddleware,
        authorize({ modelName, action: "CREATE" }),
        asyncHandler(async (req, res) => {
          const userId = (req as any).user?.id ?? null;
          const payload = req.body;
          const created = await recordService.createRecordService(modelName, payload, userId);
          res.status(201).json({ success: true, record: created });
        })
      );

      /** List */
      r.get(
        "/",
        authenticateMiddleware,
        authorize({ modelName, action: "READ" }),
        asyncHandler(async (req, res) => {
          const limit = Number(req.query.limit ?? 20);
          const skip = Number(req.query.skip ?? 0);
          const ownerOnly = String(req.query.ownerOnly ?? "false") === "true";
          const userId = (req as any).user?.id ?? null;
          const result = await recordService.listRecordsService(modelName, {
            limit,
            skip,
            ownerOnly,
            userId,
          });
          res.json({ success: true, ...result });
        })
      );

      /** Read single */
      r.get(
        "/:id",
        authenticateMiddleware,
        authorize({ modelName, action: "READ" }),
        asyncHandler(async (req, res) => {
          const id = String(req.params.id);
          const rec = await recordService.getRecordService(modelName, id);
          res.json({ success: true, record: rec });
        })
      );

      /** Update */
      r.put(
        "/:id",
        authenticateMiddleware,
        authorize({ modelName, action: "UPDATE" }),
        asyncHandler(async (req, res) => {
          const id = String(req.params.id);
          const payload = req.body;
          const userId = (req as any).user?.id ?? null;
          const updated = await recordService.updateRecordService(modelName, id, payload, userId);
          res.json({ success: true, record: updated });
        })
      );

      /** Delete */
      r.delete(
        "/:id",
        authenticateMiddleware,
        authorize({ modelName, action: "DELETE" }),
        asyncHandler(async (req, res) => {
          const id = String(req.params.id);
          const userId = (req as any).user?.id ?? null;
          await recordService.deleteRecordService(modelName, id, userId);
          res.json({ success: true, deleted: true });
        })
      );

      /** Mount per-model router */
      router.use(`/${lowerName}`, r);

      console.info(`[modelLoader] mounted model routes for: ${modelName} -> /api/${lowerName}`);
    } catch (err) {
      console.warn(`[modelLoader] skipping file ${fname} due to error: ${(err as Error).message}`);
    }
  }

  /** Catch-all 404 for unmatched model routes */
  router.use((_req, res) => {
    res.status(404).json({ success: false, message: "Model API route not found" });
  });

  return router;
}

/** Mount parent router that forwards to currentRouter */
export async function mountDynamicRouter(app: Application): Promise<void> {
  ensureModelsDir();
  parentRouter = Router();

  // currentRouter has handle() because it's a function middleware
  parentRouter.use((req: Request, res: Response, next: NextFunction) => {
    (currentRouter as any)(req, res, next);
  });

  app.use("/api", parentRouter);

  const built = await buildDynamicRouter();
  currentRouter = built;
  lastReloadToken = uuidv4();

  console.info(`[modelLoader] dynamic /api router mounted (token=${lastReloadToken})`);
}

/** Hot reload logic — rebuild routes atomically */
async function reloadRoutesAtomic(): Promise<void> {
  try {
    const newRouter = await buildDynamicRouter();
    currentRouter = newRouter;
    lastReloadToken = uuidv4();
    console.info(`[modelLoader] dynamic routes reloaded (token=${lastReloadToken})`);
  } catch (err) {
    console.error("[modelLoader] failed to reload routes, keeping old router:", err);
  }
}

/** Start chokidar watcher for hot reloading */
export function startModelWatcher(): void {
  ensureModelsDir();

  if (watcher) {
    console.warn("[modelLoader] watcher already running");
    return;
  }

  watcher = chokidar.watch(FILE_GLOB, {
    persistent: true,
    ignoreInitial: false,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
  });

  let timer: NodeJS.Timeout | null = null;
  const scheduleReload = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      reloadRoutesAtomic().catch(console.error);
      timer = null;
    }, WATCH_DEBOUNCE_MS);
  };

  watcher.on("add", (p: string) => {
    console.info(`[modelLoader] model file added: ${p}`);
    scheduleReload();
  });

  watcher.on("change", (p: string) => {
    console.info(`[modelLoader] model file changed: ${p}`);
    scheduleReload();
  });

  watcher.on("unlink", (p: string) => {
    console.info(`[modelLoader] model file removed: ${p}`);
    scheduleReload();
  });

  watcher.on("error", (err: any) => {
    console.error("[modelLoader] watcher error:", err);
  });

  console.info(`[modelLoader] watching model files: ${FILE_GLOB}`);
}

/** Stop watcher (for tests or graceful shutdown) */
export async function stopModelWatcher(): Promise<void> {
  if (watcher) {
    await watcher.close();
    watcher = null;
    console.info("[modelLoader] watcher stopped");
  }
}
