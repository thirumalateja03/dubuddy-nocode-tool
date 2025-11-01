// src/controllers/auth.controller.ts
import { Request, Response } from "express";
import { asyncHandler } from "../handlers/asyncHandler";
import { ApiError } from "../handlers/errorHandler";
import prisma from "../utils/prisma";
import {
  loginUser,
  registerUser,
  validateRefreshTokenCombined,
  rotateRefreshTokenCombined,
  signAccessToken,
  revokeRefreshTokenCombined,
} from "../services/auth.service";

function setRefreshCookie(res: Response, refreshToken: string, expiresAt: Date | string) {
  const cookieName = "refreshToken";
  const secure = process.env.COOKIE_SECURE === "true";
  const sameSite = (process.env.COOKIE_SAMESITE as any) ?? "lax";
  const maxAge = typeof expiresAt === "string" ? undefined : Math.max(0, new Date(expiresAt).getTime() - Date.now());

  res.cookie(cookieName, refreshToken, {
    httpOnly: true,
    secure,
    sameSite,
    path: "/",
    maxAge: maxAge ?? undefined,
  });
}

export const register = asyncHandler(async (req: Request, res: Response) => {
  const { email, password, name, role } = req.body;
  if (!email || !password) throw new ApiError(400, "email and password required");
  const user = await registerUser(email, password, name, role);
  res.status(201).json({
    success: true,
    user: { id: user.id, email: user.email, name: user.name },
  });
});

export const token = asyncHandler(async (req: Request, res: Response) => {
  const ip = req.ip;
  if (!req.body) throw new ApiError(400, "Request body required");

  if (req.body.email && req.body.password) {
    const { email, password, useCookie } = req.body;
    const { accessToken, refreshToken, refreshExpiresAt, user } = await loginUser(email, password, ip);

    if (useCookie) setRefreshCookie(res, refreshToken, refreshExpiresAt);

    return res.json({
      success: true,
      accessToken,
      refreshToken: useCookie ? undefined : refreshToken,
      refreshExpiresAt,
      user: { id: user.id, email: user.email, roleId: user.roleId, roleName: user.role },
    });
  }

  const incoming = req.body.refreshToken ?? (req.cookies ? req.cookies.refreshToken : undefined);
  if (!incoming) throw new ApiError(400, "refreshToken required to refresh");

  const dbToken = await validateRefreshTokenCombined(incoming);
  const rotated = await rotateRefreshTokenCombined(incoming, ip);

  const user = await prisma.user.findUnique({ where: { id: dbToken.userId }, include: { role: true } });
  if (!user) throw new ApiError(401, "User not found");

  const accessToken = signAccessToken({ id: user.id, email: user.email, roleName: user.role?.name ?? null });

  const useCookie = Boolean(req.body.useCookie || (req.cookies && req.cookies.refreshToken));
  if (useCookie) setRefreshCookie(res, rotated.combined, rotated.expiresAt);

  await prisma.auditLog.create({
    data: {
      userId: user.id,
      action: "REFRESH_TOKEN_ROTATED",
      details: { oldTokenId: dbToken.id, newTokenId: rotated.id },
    },
  });

  return res.json({
    success: true,
    accessToken,
    refreshToken: useCookie ? undefined : rotated.combined,
    refreshExpiresAt: rotated.expiresAt,
  });
});

export const logout = asyncHandler(async (req: Request, res: Response) => {
  const incoming = (req.body && req.body.refreshToken) ?? (req.cookies && req.cookies.refreshToken) ?? undefined;
  if (!incoming) throw new ApiError(400, "refreshToken required to logout");

  await revokeRefreshTokenCombined(incoming);

  if (req.cookies && req.cookies.refreshToken) {
    res.clearCookie("refreshToken", { path: "/" });
  }

  res.json({ success: true, message: "Logged out" });
});
