/**
 * Fills the `{token}` placeholders in `GET /feeds/{id}/subscribe` with the ICS token held in memory,
 * giving every link the Subscribe tabs show. The token is base64url, so it needs no escaping.
 */
import type { components } from '@supercal/api-client';

export type SubscribeInfo = components['schemas']['SubscribeInfo'];

export type FeedLink = { id: string; name: string; https: string; webcal: string; google: string };

const TOKEN = '{token}';

const webcalOf = (url: string) => url.replace(/^https?:/, 'webcal:');
/** Google's "add by URL" link; it takes the webcal form (the server builds the combined one the same way). */
const googleFor = (webcal: string) => `https://calendar.google.com/calendar/render?cid=${encodeURIComponent(webcal)}`;

export function subscribeLinks(info: SubscribeInfo, token: string) {
  const origin = new URL(info.caldav.serverUrl).origin;
  const fill = (value: string) => value.replaceAll(TOKEN, token);
  const link = (id: string, name: string, path: string): FeedLink => {
    const https = origin + fill(path);
    return { id, name, https, webcal: webcalOf(https), google: googleFor(webcalOf(https)) };
  };
  const combined = link('all', 'All calendars (combined)', info.ics.combinedPath);
  return {
    combined: { ...combined, google: fill(info.links.google) },
    publications: info.ics.publications.map((publication) => link(publication.id, publication.name, publication.path)),
    outlookPersonal: fill(info.links.outlookPersonal),
    outlookWork: fill(info.links.outlookWork),
  };
}

export type SubscribeLinks = ReturnType<typeof subscribeLinks>;
