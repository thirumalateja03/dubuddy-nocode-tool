import prisma from "../utils/prisma";
import { ApiError } from "../handlers/errorHandler";

/**
 * Return overall counts for dashboard/support
 */
export async function getSupportStats() {
  // run in parallel
  const [
    modelsCount,
    usersCount,
    rolesCount,
    recordsCount,
    publishedCount,
  ] = await Promise.all([
    prisma.modelDefinition.count(),
    prisma.user.count(),
    prisma.role.count(),
    prisma.record.count(),
    prisma.modelDefinition.count({ where: { published: true } }),
  ]);

  return {
    models: modelsCount,
    users: usersCount,
    roles: rolesCount,
    records: recordsCount,
    published: publishedCount,
  };
}

/**
 * Sanitize audit details by removing or redacting sensitive keys.
 * This function recursively walks objects/arrays and replaces sensitive values with "[REDACTED]".
 */
function sanitizeDetails(obj: any): any {
  if (obj === null || obj === undefined) return obj;

  const sensitiveKeys = new Set([
    "password",
    "pwd",
    "token",
    "refreshToken",
    "tokenHash",
    "email",
    "ssn",
    "creditCard",
    "cardNumber",
    "cvv",
    "ip",
    "ipAddress",
    "authorization",
    "auth",
    "headers",
    "payload",
    "body",
  ]);

  if (Array.isArray(obj)) {
    return obj.map((v) => sanitizeDetails(v));
  }

  if (typeof obj === "object") {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (sensitiveKeys.has(k.toLowerCase())) {
        out[k] = "[REDACTED]";
        continue;
      }
      // if value is a primitive and possibly long (like big JSON payload), truncate
      if (typeof v === "string") {
        // small heuristic: if it's obviously a long JSON or base64, redact
        if (v.length > 1000) out[k] = "[REDACTED_LONG]";
        else out[k] = v;
        continue;
      }
      out[k] = sanitizeDetails(v);
    }
    return out;
  }

  // primitives
  return obj;
}

/**
 * Build a safe audit log shape to return to clients (non-confidential).
 */
function toSafeAuditLog(a: any) {
  return {
    id: a.id,
    action: a.action,
    modelName: a.modelName ?? null,
    recordId: a.recordId ?? null,
    userId: a.userId ?? null,
    createdAt: a.createdAt,
    details: sanitizeDetails(a.details ?? {}),
  };
}

/**
 * Get recent audit logs, sanitized. Default order: newest first.
 * limit: number of logs to return (1..100)
 */
export async function getAuditLogs(limit = 10) {
  if (!Number.isInteger(limit) || limit < 1) limit = 10;
  limit = Math.min(limit, 100);

  const logs = await prisma.auditLog.findMany({
    orderBy: { createdAt: "desc" },
    take: limit,
    select: {
      id: true,
      userId: true,
      action: true,
      modelName: true,
      recordId: true,
      details: true,
      createdAt: true,
    },
  });

  // map and sanitize
  return logs.map((l) => toSafeAuditLog(l));
}
