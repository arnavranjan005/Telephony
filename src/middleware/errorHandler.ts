import { NextFunction, Request, Response } from "express";

export function notFoundHandler(req: Request, res: Response) {
  res.status(404).json({ error: `Route not found: ${req.method} ${req.originalUrl}` });
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  const message = err instanceof Error ? err.message : "Internal server error";
  // eslint-disable-next-line no-console
  console.error(err);
  res.status(500).json({ error: message });
}
