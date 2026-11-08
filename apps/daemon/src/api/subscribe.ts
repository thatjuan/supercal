/**
 * Subscribe helpers (architecture §9): what the dashboard needs to add a feed to a calendar client.
 * CalDAV settings, ICS paths, Google and Outlook one-click links, and an unsigned Apple
 * `.mobileconfig`. No response carries a secret: links hold a `{token}` placeholder the dashboard
 * fills with the token it got at creation or rotation, or `POST …/subscribe/links` expands them
 * for a caller that proves it holds the token.
 */
import { createRoute, z } from '@hono/zod-openapi';
import { withTenant, type Feed } from '@supercal/db';
import { icsTokenHash } from '../feeds/credentials.ts';
import { BadRequest, createApiApp, problemResponses, typeId } from './kit/index.ts';

/** Stands in for the ICS token in paths and links. A real token (base64url) never contains braces. */
const TOKEN = '{token}';

const FRESHNESS = {
  caldav: 'client polls, typically 1–15 min',
  google: 'Google refreshes subscribed URLs every 6–24 hours; use a sink for faster updates',
  outlook: 'about 3–6 hours, sometimes longer',
} as const;

export const SubscribeLinks = z
  .object({ google: z.url(), outlookPersonal: z.url(), outlookWork: z.url() })
  .openapi('SubscribeLinks', { description: 'One-click links for subscribing to an ICS calendar URL' });

const SubscribeInfo = z
  .object({
    caldav: z.object({ serverUrl: z.url(), username: z.string(), principalUrl: z.url(), wellKnown: z.url() }),
    ics: z.object({
      hasToken: z.boolean().openapi({ description: 'False until a token is issued; if the user lost it, rotate to get a new one' }),
      publications: z.array(z.object({ id: typeId('pub'), name: z.string(), path: z.string() })),
      combinedPath: z.string(),
    }),
    links: SubscribeLinks,
    appleProfileUrl: z.string(),
    freshness: z.object({ caldav: z.string(), google: z.string(), outlook: z.string() }),
  })
  .openapi('SubscribeInfo', {
    description:
      'ICS paths and links contain the literal placeholder `{token}`: replace it with the ICS token returned by feed creation or `rotateFeedIcsToken` (base64url, so it needs no further escaping). The token itself is never returned here.',
  });

const params = z.object({ id: typeId('feed') });
const tags = ['Feeds'];

const getSubscribe = createRoute({
  method: 'get',
  path: '/api/v1/feeds/{id}/subscribe',
  operationId: 'getFeedSubscribeInfo',
  tags,
  request: { params },
  responses: {
    200: { description: 'How to subscribe to the feed, with `{token}` placeholders', content: { 'application/json': { schema: SubscribeInfo } } },
    ...problemResponses(400, 401, 403, 404),
  },
});

const expandLinks = createRoute({
  method: 'post',
  path: '/api/v1/feeds/{id}/subscribe/links',
  operationId: 'expandFeedSubscribeLinks',
  tags,
  request: { params, body: { required: true, content: { 'application/json': { schema: z.object({ token: z.string().min(1) }) } } } },
  responses: {
    200: { description: 'The subscribe links with the token filled in', content: { 'application/json': { schema: SubscribeLinks } } },
    ...problemResponses(400, 401, 403, 404),
  },
});

const getMobileconfig = createRoute({
  method: 'get',
  path: '/api/v1/feeds/{id}/mobileconfig',
  operationId: 'getFeedMobileconfig',
  tags,
  request: { params },
  responses: {
    200: {
      description: 'An unsigned `com.apple.caldav.account` profile without the password; the device asks for it during install',
      content: { 'application/x-apple-aspen-config': { schema: z.string() } },
    },
    ...problemResponses(400, 401, 403, 404),
  },
});

const icsPath = (token: string, slug: string) => `/ics/${token}/${slug}.ics`;
/** Percent-encodes a query value, leaving the `{token}` placeholder readable. */
const param = (value: string) => encodeURIComponent(value).replaceAll(encodeURIComponent(TOKEN), TOKEN);

/** One-click links for the combined feed. Google takes the webcal URL, Outlook the https one. */
export function subscribeLinks(publicUrl: string, feedName: string, token: string): z.infer<typeof SubscribeLinks> {
  return calendarSubscribeLinks(`${publicUrl}${icsPath(token, 'all')}`, feedName);
}

/** One-click subscriptions for an absolute ICS URL. */
export function calendarSubscribeLinks(url: string, name: string): z.infer<typeof SubscribeLinks> {
  const webcal = url.replace(/^https?:/, 'webcal:');
  const outlook = (host: string) => `https://${host}/calendar/0/addfromweb?url=${param(url)}&name=${param(name)}`;
  return {
    google: `https://calendar.google.com/calendar/render?cid=${param(webcal)}`,
    outlookPersonal: outlook('outlook.live.com'),
    outlookWork: outlook('outlook.office.com'),
  };
}

const xml = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** A stable UUID from `seed`, so reinstalling a feed's profile replaces it instead of adding a copy. */
function uuidFrom(seed: string): string {
  const h = new Bun.CryptoHasher('sha256').update(seed).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`.toUpperCase();
}

/**
 * An unsigned `.mobileconfig` adding the feed as a read-only CalDAV account. It holds no password
 * (Apple documents `CalDAVPassword` for encrypted profiles only), so the device prompts for the app
 * password at install and the file is not a credential.
 */
export function caldavMobileconfig({ publicUrl, feed }: { publicUrl: string; feed: Pick<Feed, 'id' | 'name' | 'caldavUsername'> }): string {
  const server = new URL(publicUrl);
  const port = Number(server.port) || (server.protocol === 'https:' ? 443 : 80);
  const kv = (key: string, value: string | number | boolean) =>
    `<key>${key}</key>${typeof value === 'boolean' ? `<${value}/>` : typeof value === 'number' ? `<integer>${value}</integer>` : `<string>${xml(value)}</string>`}`;
  const payload = [
    kv('PayloadType', 'com.apple.caldav.account'),
    kv('PayloadVersion', 1),
    kv('PayloadIdentifier', `dev.supercal.feed.${feed.id}.caldav`),
    kv('PayloadUUID', uuidFrom(`caldav:${feed.id}`)),
    kv('PayloadDisplayName', `${feed.name} (CalDAV)`),
    kv('CalDAVAccountDescription', feed.name),
    kv('CalDAVHostName', server.hostname),
    kv('CalDAVPort', port),
    kv('CalDAVUseSSL', true),
    kv('CalDAVPrincipalURL', `${server.origin}/dav/${feed.caldavUsername}/`),
    kv('CalDAVUsername', feed.caldavUsername),
  ].join('\n      ');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <array>
    <dict>
      ${payload}
    </dict>
  </array>
  ${kv('PayloadType', 'Configuration')}
  ${kv('PayloadVersion', 1)}
  ${kv('PayloadIdentifier', `dev.supercal.feed.${feed.id}`)}
  ${kv('PayloadUUID', uuidFrom(`profile:${feed.id}`))}
  ${kv('PayloadDisplayName', `Supercal: ${feed.name}`)}
  ${kv('PayloadDescription', 'Adds your Supercal feed as a read-only calendar account.')}
  ${kv('PayloadOrganization', 'Supercal')}
  ${kv('PayloadRemovalDisallowed', false)}
</dict>
</plist>
`;
}

const origin = (publicUrl: string) => publicUrl.replace(/\/$/, '');

export const subscribeRoutes = createApiApp()
  .openapi(getSubscribe, async (c) => {
    const { id } = c.req.valid('param');
    const { feed, publications } = await withTenant(c.var.principal.tenantId, async (tx) => ({
      feed: await c.var.feeds.getFeed(tx, c.var.principal, id),
      publications: await c.var.feeds.listPublications(tx, c.var.principal, id),
    }));
    const base = origin(c.var.auth.publicUrl);
    return c.json(
      {
        caldav: {
          serverUrl: `${base}/dav/`,
          username: feed.caldavUsername,
          principalUrl: `${base}/dav/${feed.caldavUsername}/`,
          wellKnown: `${base}/.well-known/caldav`,
        },
        ics: {
          hasToken: feed.icsTokenHash !== null,
          publications: publications.filter((p) => p.enabled).map((p) => ({ id: p.id, name: p.name, path: icsPath(TOKEN, p.slug) })),
          combinedPath: icsPath(TOKEN, 'all'),
        },
        links: subscribeLinks(base, feed.name, TOKEN),
        appleProfileUrl: `/api/v1/feeds/${feed.id}/mobileconfig`,
        freshness: FRESHNESS,
      },
      200,
    );
  })
  .openapi(expandLinks, async (c) => {
    const { id } = c.req.valid('param');
    const { token } = c.req.valid('json');
    const feed = await withTenant(c.var.principal.tenantId, (tx) => c.var.feeds.getFeed(tx, c.var.principal, id));
    if (feed.icsTokenHash === null || icsTokenHash(token) !== feed.icsTokenHash)
      throw new BadRequest([{ path: 'token', message: 'is not the feed’s current ICS token' }], 'The token does not match this feed');
    return c.json(subscribeLinks(origin(c.var.auth.publicUrl), feed.name, token), 200);
  })
  .openapi(getMobileconfig, async (c) => {
    const { id } = c.req.valid('param');
    const feed = await withTenant(c.var.principal.tenantId, (tx) => c.var.feeds.getFeed(tx, c.var.principal, id));
    return c.body(caldavMobileconfig({ publicUrl: c.var.auth.publicUrl, feed }), 200, {
      'Content-Type': 'application/x-apple-aspen-config',
      'Content-Disposition': 'attachment; filename="supercal.mobileconfig"',
    });
  });
