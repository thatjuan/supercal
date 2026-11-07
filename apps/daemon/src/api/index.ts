import { Hono } from 'hono';

/** Management API routes, mounted at `/api` when the `api` role is enabled. */
export const api = new Hono();
