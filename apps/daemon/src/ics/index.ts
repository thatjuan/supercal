import { Hono } from 'hono';

/** ICS feed routes, mounted at `/ics` when the `dav` role is enabled. */
export const ics = new Hono();
