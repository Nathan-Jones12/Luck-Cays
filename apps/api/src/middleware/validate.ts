/**
 * Boundary validation. Every body, query and param is parsed by a zod schema from
 * `packages/shared` before a route handler sees it.
 *
 * The parsed value REPLACES the raw one, so a handler cannot accidentally read an
 * unvalidated field: anything the schema did not describe is gone by the time the
 * handler runs. That is what makes "parse at the boundary, trust the type inward" true
 * rather than aspirational.
 */
import type { RequestHandler } from "express";
import { ZodError, type ZodTypeAny, type z } from "zod";
import { badRequest } from "../lib/errors.js";

/** Turn zod's issue list into something a client can show next to a field. */
function fieldErrors(error: ZodError): Record<string, string> {
  const result: Record<string, string> = {};
  for (const issue of error.issues) {
    const path = issue.path.join(".") || "_";
    // First error per field: a list of five complaints about one input is noise.
    result[path] ??= issue.message;
  }
  return result;
}

export function validateBody<S extends ZodTypeAny>(schema: S): RequestHandler {
  return (request, _response, next) => {
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) {
      return next(
        badRequest("VALIDATION_FAILED", "Check the submitted values", fieldErrors(parsed.error)),
      );
    }
    request.body = parsed.data;
    next();
  };
}

export function validateQuery<S extends ZodTypeAny>(schema: S): RequestHandler {
  return (request, _response, next) => {
    const parsed = schema.safeParse(request.query);
    if (!parsed.success) {
      return next(
        badRequest("VALIDATION_FAILED", "Check the query parameters", fieldErrors(parsed.error)),
      );
    }
    // Express 4's `query` is a getter on some setups; define it rather than assign.
    Object.defineProperty(request, "query", {
      value: parsed.data,
      writable: true,
      configurable: true,
    });
    next();
  };
}

export function validateParams<S extends ZodTypeAny>(schema: S): RequestHandler {
  return (request, _response, next) => {
    const parsed = schema.safeParse(request.params);
    if (!parsed.success) {
      return next(
        badRequest("VALIDATION_FAILED", "Check the request path", fieldErrors(parsed.error)),
      );
    }
    Object.defineProperty(request, "params", {
      value: parsed.data,
      writable: true,
      configurable: true,
    });
    next();
  };
}

/** Typed accessors, so handlers get the schema's output type rather than `any`. */
export function body<S extends ZodTypeAny>(request: { body: unknown }, _schema: S): z.infer<S> {
  return request.body as z.infer<S>;
}

export function query<S extends ZodTypeAny>(request: { query: unknown }, _schema: S): z.infer<S> {
  return request.query as z.infer<S>;
}

/**
 * Parse a socket message. Sockets have no middleware chain, so handlers call this
 * directly - and must, because an unvalidated socket payload is exactly as dangerous as
 * an unvalidated request body.
 */
export function parseSocketMessage<S extends ZodTypeAny>(schema: S, payload: unknown): z.infer<S> {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw badRequest("VALIDATION_FAILED", "Invalid message", fieldErrors(parsed.error));
  }
  return parsed.data;
}
