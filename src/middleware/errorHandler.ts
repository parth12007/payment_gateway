import type { NextFunction, Request, Response } from 'express';
import { logger } from '../infra/logger.js';

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const requestId = req.requestId ?? 'unknown';

  if (err instanceof HttpError) {
    logger.warn({ requestId, code: err.code, status: err.status, msg: err.message }, 'http error');
    res.status(err.status).json({
      error: { code: err.code, message: err.message, request_id: requestId },
    });
    return;
  }

  const message = err instanceof Error ? err.message : String(err);
  logger.error({ requestId, err: message }, 'unhandled error');
  res.status(500).json({
    error: { code: 'internal_error', message: 'Internal server error', request_id: requestId },
  });
}
