import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';

/**
 * One place where an error becomes an HTTP response.
 *
 * Internal detail is not sent to the browser: a client gets a message it can
 * act on and nothing about the stack, the database or the file system. Errors
 * thrown deliberately by the services carry a `status`, and those messages are
 * written to be read by a person, so they are passed through.
 */

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function notFound(_req: Request, res: Response): void {
  res.status(404).json({ error: 'No such endpoint.' });
}

export function errorHandler(
  error: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (error instanceof ZodError) {
    res.status(400).json({
      error: 'The request body is not valid.',
      details: error.issues.map((issue) => ({
        field: issue.path.join('.'),
        message: issue.message,
      })),
    });
    return;
  }

  const status = (error as { status?: number }).status;
  if (typeof status === 'number' && status >= 400 && status < 500) {
    res.status(status).json({ error: (error as Error).message });
    return;
  }

  logger.error({ err: error }, 'unhandled error');
  res.status(500).json({
    error: 'Something went wrong handling that request.',
    ...(env.NODE_ENV === 'development' ? { detail: (error as Error).message } : {}),
  });
}

/** Wraps an async handler so a rejected promise reaches the error handler. */
export function asyncHandler<T extends Request>(
  handler: (req: T, res: Response, next: NextFunction) => Promise<unknown>,
) {
  return (req: T, res: Response, next: NextFunction): void => {
    handler(req, res, next).catch(next);
  };
}
