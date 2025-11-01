// src/middleware/errorHandler.ts
import { Request, Response, NextFunction } from "express";
import { PrismaClientKnownRequestError, PrismaClientValidationError } from "../generated/prisma/internal/prismaNamespace";

export interface AppError extends Error {
  statusCode?: number;
  isOperational?: boolean;
  details?: any;
}

/**
 * Custom Error Class for predictable operational errors.
 */
export class ApiError extends Error implements AppError {
  statusCode: number;
  isOperational: boolean;
  details?: any;

  constructor(statusCode: number, message: string, details?: any) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = true;
    this.details = details;
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Global Express Error Handler
 */
export function globalErrorHandler(
  err: any,
  req: Request,
  res: Response,
  next: NextFunction
) {
  // console.error("💥 Error caught by global handler:", err);

  let statusCode = err.statusCode || 500;
  let message = err.message || "Internal Server Error";
  let details = err.details || undefined;

  // Prisma-specific errors
  if (err instanceof PrismaClientKnownRequestError) {
    switch (err.code) {
      case "P2002":
        statusCode = 400;
        message = "Unique constraint failed (duplicate record).";
        details = err.meta;
        break;
      case "P2025":
        statusCode = 404;
        message = "Record not found.";
        break;
      default:
        message = "Database operation failed.";
        details = err.meta;
        break;
    }
  }

  // Prisma validation errors
  else if (err instanceof PrismaClientValidationError) {
    statusCode = 400;
    message = "Invalid data format or missing required fields.";
  }

  // Generic JSON response
  res.status(statusCode).json({
    success: false,
    message,
    ...(details && { details }),
    ...(process.env.NODE_ENV === "development" && { stack: err.stack }),
  });
}
