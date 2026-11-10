/**
 * The CalDAV adapters: generic CalDAV (`caldav`) and iCloud (`icloud`, the same adapter with
 * Apple's server and partition hosts). Both poll; discovery is `discovery.ts`, event sync `sync.ts`,
 * writes `writes.ts`; every request goes through the guarded transport (`session.ts`).
 */
import { AuthFailedError, type AdapterContext, type ProviderAdapter } from '../adapter.ts';
import type { ProviderCredentials } from '../credentials.ts';
import { discoverHome, listCollections, type Incremental } from './discovery.ts';
import { createDavSession } from './session.ts';
import { caldavWrites } from './writes.ts';
import { syncCollection, type CaldavCursor } from './sync.ts';

export { UnsupportedAuthError } from './session.ts';
export type { CaldavCursor } from './sync.ts';

/** Where and as whom an account logs in. Credentials are sent only to `origins` or trusted HTTPS `hosts`. */
export type CaldavLogin = { serverUrl: string; username: string; password: string; hosts: string[]; origins: string[] };

export const ICLOUD_SERVER_URL = 'https://caldav.icloud.com/';
/** iCloud redirects into partition hosts (`p42-caldav.icloud.com`); credentials may follow there. */
export const ICLOUD_HOSTS = ['caldav.icloud.com', '*.icloud.com'];

/** Builds a CalDAV adapter for `provider`, with `login` turning its stored credentials into a login. */
export function createCaldavAdapter(provider: 'caldav' | 'icloud', login: (credentials: ProviderCredentials) => CaldavLogin): ProviderAdapter<CaldavCursor> {
  const session = (ctx: AdapterContext) => {
    const account = login(ctx.credentials);
    return { account, dav: createDavSession(ctx, account) };
  };
  return {
    provider,
    format: 'ical',
    capabilities: { calendarDiscovery: 'poll', push: 'none' },
    async listCalendars(ctx) {
      const { account, dav } = session(ctx);
      return listCollections(dav, await discoverHome(dav, account.serverUrl));
    },
    writes: {
      put: (ctx, calendar, ics, existing) => caldavWrites.put(session(ctx).dav, calendar, ics, existing),
      delete: (ctx, calendar, existing) => caldavWrites.delete(session(ctx).dav, calendar, existing),
    },
    sync(ctx, calendar, cursor) {
      const { dav } = session(ctx);
      const incremental: Incremental = calendar.capabilities.incremental === 'etag' ? 'etag' : 'sync-collection';
      return syncCollection(dav, calendar.providerCalendarId, incremental, cursor);
    },
  };
}

export const caldavAdapter = createCaldavAdapter('caldav', (credentials) => {
  if (credentials.provider !== 'caldav') throw new AuthFailedError('these are not CalDAV credentials');
  const { serverUrl, username, password } = credentials;
  const server = new URL(serverUrl);
  const origins = [server.origin];
  if (server.protocol === 'http:') origins.push(`https://${server.hostname}`);
  return { serverUrl, username, password, hosts: [], origins };
});

/** iCloud's login for stored credentials; tests point `serverUrl` at a local server. */
export function icloudLogin(credentials: ProviderCredentials, serverUrl = ICLOUD_SERVER_URL): CaldavLogin {
  if (credentials.provider !== 'icloud') throw new AuthFailedError('these are not iCloud credentials');
  return { serverUrl, username: credentials.appleId, password: credentials.appSpecificPassword, hosts: ICLOUD_HOSTS, origins: [new URL(serverUrl).origin] };
}

export const icloudAdapter = createCaldavAdapter('icloud', (credentials) => icloudLogin(credentials));
