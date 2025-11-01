// src/services/auth.service.ts
import fs from "fs";
import path from "path";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { ApiError } from "../handlers/errorHandler";
import prisma from "../utils/prisma";
import { addSeconds } from "date-fns";

const ACCESS_TTL = Number(process.env.ACCESS_TOKEN_TTL ?? 900); // seconds
const REFRESH_TTL = Number(process.env.REFRESH_TOKEN_TTL ?? 60 * 60 * 24 * 30); // seconds
const HASH_ROUNDS = Number(process.env.HASH_ROUNDS ?? 12);
const PRIVATE_KEY_PATH = process.env.JWT_PRIVATE_KEY_PATH ?? "./keys/private.pem";
const PUBLIC_KEY_PATH = process.env.JWT_PUBLIC_KEY_PATH ?? "./keys/public.pem";
const JWT_ISSUER = process.env.JWT_ISSUER ?? "internal-platform";

const PRIVATE_KEY = fs.readFileSync(path.resolve(PRIVATE_KEY_PATH), "utf8");
const PUBLIC_KEY = fs.readFileSync(path.resolve(PUBLIC_KEY_PATH), "utf8");

export function signAccessToken(user: { id: string; email: string; roleName?: string | null }) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: String(user.id),
    email: user.email,
    role: user.roleName ?? null,
    iss: JWT_ISSUER,
    iat: now,
  };

  return jwt.sign(payload, PRIVATE_KEY, {
    algorithm: "RS256",
    expiresIn: `${ACCESS_TTL}s`,
  });
}

/** Create new refresh token row and return combined token string for client */
export async function createRefreshTokenCombined(userId: string, ip?: string) {
  const plain = crypto.randomBytes(48).toString("hex");
  const hash = await bcrypt.hash(plain, HASH_ROUNDS);
  const expiresAt = addSeconds(new Date(), REFRESH_TTL);

  const dbToken = await prisma.refreshToken.create({
    data: {
      tokenHash: hash,
      userId,
      expiresAt,
      createdByIp: ip ?? null,
    },
  });

  const combined = `${dbToken.id}::${plain}`;
  return { combined, id: dbToken.id, expiresAt: dbToken.expiresAt };
}

function parseCombinedToken(token: string) {
  const parts = token.split("::");
  if (parts.length < 2) throw new ApiError(400, "Invalid refresh token format");
  const id = parts[0];
  const plain = parts.slice(1).join("::");
  return { id, plain };
}

export async function validateRefreshTokenCombined(combined: string) {
  const { id, plain } = parseCombinedToken(combined);
  const db = await prisma.refreshToken.findUnique({ where: { id } });
  if (!db) throw new ApiError(401, "Refresh token not found (please login)");
  if (db.revoked) throw new ApiError(401, "Refresh token revoked (please login)");
  if (db.expiresAt < new Date()) throw new ApiError(401, "Refresh token expired (please login)");

  const ok = await bcrypt.compare(plain, db.tokenHash);
  if (!ok) throw new ApiError(401, "Invalid refresh token (please login)");
  return db;
}

export async function rotateRefreshTokenCombined(oldCombined: string, ip?: string) {
  const { id: oldId, plain } = parseCombinedToken(oldCombined);

  return prisma.$transaction(async (tx) => {
    const old = await tx.refreshToken.findUnique({ where: { id: oldId } });
    if (!old) throw new ApiError(401, "Refresh token not found (please login)");
    if (old.revoked) throw new ApiError(401, "Refresh token revoked");
    if (old.expiresAt < new Date()) throw new ApiError(401, "Refresh token expired");

    const ok = await bcrypt.compare(plain, old.tokenHash);
    if (!ok) throw new ApiError(401, "Invalid refresh token");

    const newPlain = crypto.randomBytes(48).toString("hex");
    const newHash = await bcrypt.hash(newPlain, HASH_ROUNDS);
    const newExpiresAt = addSeconds(new Date(), REFRESH_TTL);

    const created = await tx.refreshToken.create({
      data: {
        tokenHash: newHash,
        userId: old.userId,
        expiresAt: newExpiresAt,
        createdByIp: ip ?? null,
      },
    });

    await tx.refreshToken.update({
      where: { id: old.id },
      data: { revoked: true, revokedAt: new Date(), replacedById: created.id },
    });

    const combined = `${created.id}::${newPlain}`;
    return { combined, id: created.id, expiresAt: created.expiresAt };
  });
}

export async function revokeRefreshTokenCombined(combined: string) {
  const { id } = parseCombinedToken(combined);
  await prisma.refreshToken.update({
    where: { id },
    data: { revoked: true, revokedAt: new Date() },
  });
}

/* Registration & Login */
export async function registerUser(email: string, password: string, name?: string | null, roleName?: string | null) {
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) throw new ApiError(400, "Email already registered");

  const hashed = await bcrypt.hash(password, HASH_ROUNDS);
  let roleId: string | null = null;
  if (roleName) {
    const role = await prisma.role.findUnique({ where: { name: roleName } });
    if (!role) throw new ApiError(400, "Invalid role");
    roleId = role.id;
  } else {
    const viewer = await prisma.role.findUnique({ where: { name: "Viewer" } });
    roleId = viewer?.id ?? null;
  }

  const user = await prisma.user.create({
    data: {
      email,
      password: hashed,
      name: name ?? null,
      roleId,
      isActive: true,
    },
  });
  return user;
}

export async function loginUser(email: string, password: string, ip?: string) {
  const user = await prisma.user.findUnique({ where: { email }, include: { role: true } });
  if (!user) throw new ApiError(401, "Invalid credentials");
  if (!user.isActive) throw new ApiError(403, "Account disabled");

  const ok = await bcrypt.compare(password, user.password);
  if (!ok) throw new ApiError(401, "Invalid credentials");

  const accessToken = signAccessToken({ id: user.id, email: user.email, roleName: user.role?.name ?? null });
  const refresh = await createRefreshTokenCombined(user.id, ip);

  await prisma.auditLog.create({
    data: {
      userId: user.id,
      action: "LOGIN",
      details: { ip },
      modelName: null,
    },
  });

  return { accessToken, refreshToken: refresh.combined, refreshExpiresAt: refresh.expiresAt, user };
}
