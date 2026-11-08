/**
 * @supercal/providers: the adapter contract and registry, provider credentials, OAuth token calls,
 * the adapters, and the guarded transport adapters fetch through. Google is not in the registry: it
 * needs client credentials, so the daemon creates it with `createGoogleAdapter` when configured.
 */
import { registry } from './adapter.ts';
import { caldavAdapter, icloudAdapter } from './caldav/index.ts';
import { icsAdapter } from './ics/index.ts';

export * from './adapter.ts';
export * from './credentials.ts';
export * from './oauth.ts';
export * from './google/index.ts';
export * from './transport/index.ts';
export { caldavAdapter, createCaldavAdapter, icloudAdapter, icloudLogin, UnsupportedAuthError, ICLOUD_HOSTS, ICLOUD_SERVER_URL, type CaldavCursor } from './caldav/index.ts';
export { icsAdapter, type IcsCursor } from './ics/index.ts';

Object.assign(registry, { caldav: caldavAdapter, icloud: icloudAdapter, ics: icsAdapter });
