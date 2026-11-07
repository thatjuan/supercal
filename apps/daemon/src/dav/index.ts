import { Hono } from 'hono';

/** CalDAV routes, mounted at the root when the `dav` role is enabled; owns `/.well-known/caldav` and `/dav/*`. */
export const dav = new Hono();
