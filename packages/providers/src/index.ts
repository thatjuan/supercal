/** @supercal/providers: the adapter contract and registry, provider credentials, and the guarded transport adapters fetch through. */
import { registry } from './adapter.ts';
import { caldavAdapter, icloudAdapter } from './caldav/index.ts';
import { icsAdapter } from './ics/index.ts';

export * from './adapter.ts';
export * from './credentials.ts';
export * from './transport/index.ts';
export { caldavAdapter, createCaldavAdapter, icloudAdapter, icloudLogin, UnsupportedAuthError, ICLOUD_HOSTS, ICLOUD_SERVER_URL, type CaldavCursor } from './caldav/index.ts';
export { icsAdapter, type IcsCursor } from './ics/index.ts';

Object.assign(registry, { caldav: caldavAdapter, icloud: icloudAdapter, ics: icsAdapter });
