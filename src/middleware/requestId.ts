import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

declare module 'express-serve-static-core' {
  interface Request {
    requestId: string;
  }
}

const HEADER = 'x-request-id';

export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header(HEADER);
  const id = incoming && incoming.length > 0 && incoming.length <= 128 ? incoming : randomUUID();
  req.requestId = id;
  res.setHeader(HEADER, id);
  next();
}
