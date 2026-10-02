/**
 * The error boundary and the 404 handler.
 *
 * One rule: a response body never contains anything we did not deliberately put there.
 * `AppError` carries a safe code, message and details. Everything else becomes an opaque
 * 500 - an unexpected error's message can hold a file path, a SQL fragment or a value
 * from the database, none of which belong in an HTTP response.
 */
import type { ErrorRequestHandler, RequestHandler } from "express";
import { Prisma } from "@prisma/client";
import type { ApiErrorBody } from "@luck-cays/shared";
import { AppError } from "../lib/errors.js";
import { logger } from "../lib/logger.js";
import { isProduction } from "../lib/env.js";

export const notFoundHandler: RequestHandler = (request, response) => {
  const body: ApiErrorBody = {
    error: { code: "NOT_FOUND", message: `No route for ${request.method} ${request.path}` },
  };
  response.status(404).json(body);
};

/**
 * Map the Prisma errors that represent a client mistake onto a 4xx. Anything else is a
 * server fault and falls through to the 500 path.
 */
function fromPrisma(error: unknown): AppError | null {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    switch (error.code) {
      case "P2002":
        // Unique constraint. The field names are our own schema's, not user data.
        return new AppError(409, "ALREADY_EXISTS", "That value is already taken", {
          fields: error.meta?.["target"] ?? null,
        });
      case "P2003":
        return new AppError(400, "INVALID_REFERENCE", "That referenced record does not exist");
      case "P2025":
        return new AppError(404, "NOT_FOUND", "That record does not exist");
      default:
        return null;
    }
  }

  if (error instanceof Prisma.PrismaClientValidationError) {
    // The message describes our query shape, so it must not be returned.
    return new AppError(400, "INVALID_REQUEST", "The request could not be processed");
  }

  return null;
}

export const errorHandler: ErrorRequestHandler = (error, request, response, next) => {
  if (response.headersSent) return next(error);

  const appError = error instanceof AppError ? error : fromPrisma(error);

  if (appError) {
    // 4xx is the client's problem and routine; 5xx is ours and worth a stack.
    if (appError.status >= 500) {
      logger.error({ err: error, path: request.path, code: appError.code }, "request failed");
    } else {
      logger.debug(
        { path: request.path, code: appError.code, status: appError.status },
        "request rejected",
      );
    }

    const body: ApiErrorBody = {
      error: {
        code: appError.code,
        message: appError.message,
        ...(appError.details === undefined ? {} : { details: appError.details }),
      },
    };
    response.status(appError.status).json(body);
    return;
  }

  logger.error({ err: error, path: request.path, method: request.method }, "unhandled error");

  const body: ApiErrorBody = {
    error: {
      code: "INTERNAL_ERROR",
      message: "Something went wrong",
      // Outside production, surface the message to make debugging bearable. Never the
      // stack, and never in production.
      ...(isProduction
        ? {}
        : { details: { message: error instanceof Error ? error.message : String(error) } }),
    },
  };
  response.status(500).json(body);
};
