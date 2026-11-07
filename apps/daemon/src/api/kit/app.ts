import { OpenAPIHono } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { createLogger } from '../../log.ts';
import type { ApiEnv } from '../../auth/principal.ts';
import { BadRequest, ProblemError, Unauthorized } from './problem.ts';

const log = createLogger({ component: 'api' });

/** Maps anything thrown by a handler or middleware to a problem; unknown errors become an opaque 500. */
function toProblemError(error: Error): ProblemError {
  if (error instanceof ProblemError) return error;
  // Hono's validator throws 400 for an unparseable body, before any schema runs.
  if (error instanceof HTTPException && error.status === 400) return new BadRequest([], 'Malformed request body');
  if (error instanceof HTTPException && error.status === 401) return new Unauthorized();
  log.error('unhandled API error', { error });
  return new ProblemError(500);
}

/** Renders a problem as `application/problem+json`. */
export function problemJson(c: Context, error: ProblemError) {
  return c.json(error.toProblem(c.req.path), error.status, { 'Content-Type': 'application/problem+json' });
}

/**
 * The app every management route group is built on: Zod validation failures become a 400 problem
 * with per-field `errors`, and thrown errors render through `toProblemError`.
 */
export function createApiApp() {
  const app = new OpenAPIHono<ApiEnv>({
    defaultHook: (result) => {
      if (result.success) return;
      throw new BadRequest(result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })));
    },
  });
  app.onError((error, c) => problemJson(c, toProblemError(error)));
  return app;
}
