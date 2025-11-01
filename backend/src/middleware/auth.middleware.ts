// src/middleware/auth.middleware.ts
import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import fs from "fs";
import path from "path";
import { ApiError } from "../handlers/errorHandler";

const PUBLIC_KEY_PATH = process.env.JWT_PUBLIC_KEY_PATH ?? "./keys/public.pem";
const PUBLIC_KEY = fs.readFileSync(path.resolve(PUBLIC_KEY_PATH), "utf8");

export interface AuthRequest extends Request {
  user?: {
    id: string;
    email?: string | null;
    role?: string | null;
  };
}

export function authenticateMiddleware(req: AuthRequest, res: Response, next: NextFunction) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Bearer ")) {
    return next(new ApiError(401, "Missing Authorization header"));
  }

  const token = auth.split(" ")[1];
  try {
    const decoded = jwt.verify(token, PUBLIC_KEY, { algorithms: ["RS256"], issuer: process.env.JWT_ISSUER }) as any;
    req.user = {
      id: String(decoded.sub),
      email: decoded.email ?? null,
      role: decoded.role ?? null,
    };
    return next();
  } catch (err: any) {
    return next(new ApiError(401, "Invalid or expired access token"));
  }
}
