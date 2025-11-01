// src/server.ts (example)
import express from "express";
import cors from "cors";
import morgan from "morgan";
import helmet from "helmet";
import dotenv from "dotenv";
import cookieParser from "cookie-parser";

import { globalErrorHandler } from "./handlers/errorHandler";
import authRoutes from "./routes/auth.routes";
import rbacRoutes from "./routes/rbac.routes";
import modelRoutes from "./routes/models.routes";
import recordRoutes from "./routes/records.routes";
import supportRoutes from "./routes/support.routes";
import modelVersionRoutes from "./routes/modelVersions.routes";

import { mountDynamicRouter, startModelWatcher } from "./utils/modelLoader";

dotenv.config();

const app = express();

app.use(helmet());
app.use(
  cors({
    origin: "http://localhost:5173", // 👈 your Vite frontend URL
    credentials: true, // 👈 allow sending cookies/auth headers
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);
app.use(morgan("combined"));
app.use(express.json());
app.use(cookieParser());

app.use("/health", (_req, res) => res.json({ message: "Ok" }));

app.use("/auth", authRoutes);
app.use("/rbac", rbacRoutes);
app.use("/models", modelRoutes);
app.use("/models", modelVersionRoutes);
app.use("/api", recordRoutes); // static route fallback (optional) - but dynamic /api is mounted by modelLoader
app.use("/support", supportRoutes);

// Mount dynamic router BEFORE error handler
(async () => {
  await mountDynamicRouter(app); // will mount /api router for models
  startModelWatcher(); // hot-reload when model files change
})();

// global error handler last
app.use(globalErrorHandler);

const PORT = process.env.PORT ?? 3000;
app.listen(PORT, () => console.log(`Server listening on ${PORT}`));
