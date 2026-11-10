/** Conditional CalDAV UID-group writes; read back the provider's representation after every PUT. */
import { groupUidsOf } from '@supercal/core';
import { ProviderConflictError, ProviderUnavailableError, ProviderWriteRejectedError, type SourceCalendarRef, type StoredObject, type WriteResult } from '../adapter.ts';
import { DavStatusError, type DavSession } from './session.ts';
import { canonicalPath, rawObjects } from './sync.ts';

const HANDLED = [400, 403, 404, 405, 412, 415, 507];

/** A split href contains other UIDs; writing it would overwrite somebody else's event. */
function existingObject(existing: StoredObject[]): StoredObject | undefined {
  if (existing.length > 1 || existing.some((object) => object.id.includes('#')))
    throw new ProviderWriteRejectedError('read-only', 'Split CalDAV objects cannot be edited');
  return existing[0];
}

/** Map per-object refusals before the session can interpret them as account authentication errors. */
async function writeRequest(dav: DavSession, url: string, method: 'GET' | 'PUT' | 'DELETE', headers: Record<string, string>, body?: string) {
  try {
    return await dav.request(url, method, headers, body, headers['if-match'] !== undefined ? HANDLED : HANDLED.filter((status) => status !== 404));
  } catch (error) {
    if (!(error instanceof DavStatusError)) throw error;
    if (error.status === 412) throw new ProviderConflictError('The CalDAV object changed upstream');
    const reason = error.status === 403 || error.status === 405 ? 'read-only'
      : error.status === 400 || error.status === 415 ? 'invalid-data'
      : error.status === 507 ? 'quota' : 'not-found';
    throw new ProviderWriteRejectedError(reason, `CalDAV refused ${method} (HTTP ${error.status})`);
  }
}

export const caldavWrites = {
  /** PUT conditionally, then GET even when PUT returned an ETag (servers rewrite stored bytes). */
  async put(dav: DavSession, calendar: SourceCalendarRef, ics: string, existing: StoredObject[]): Promise<WriteResult> {
    const object = existingObject(existing);
    const url = object ? new URL(object.id, calendar.providerCalendarId).href
      : new URL(`${crypto.randomUUID()}.ics`, calendar.providerCalendarId.replace(/\/?$/, '/')).href;
    await writeRequest(dav, url, 'PUT', { 'content-type': 'text/calendar; charset=utf-8', ...(object ? { 'if-match': object.etag } : { 'if-none-match': '*' }) }, ics);
    const response = await writeRequest(dav, url, 'GET', {});
    const etag = response.headers.get('etag');
    if (!etag) throw new ProviderUnavailableError('The CalDAV object GET returned no ETag');
    const upserts = rawObjects(canonicalPath(response.finalUrl), etag, new TextDecoder().decode(response.body), {}, dav.log);
    if (upserts.length !== 1 || upserts[0]?.id.includes('#') || upserts[0]?.groupUid !== groupUidsOf(ics)[0]) throw new ProviderUnavailableError('The CalDAV server stored an unexpected UID group');
    return { upserts, deletes: [] };
  },
  /** Delete the original href using the ETag stored by sync. */
  async delete(dav: DavSession, calendar: SourceCalendarRef, existing: StoredObject[]): Promise<WriteResult> {
    const object = existingObject(existing);
    if (!object) throw new ProviderWriteRejectedError('not-found', 'No stored CalDAV object');
    await writeRequest(dav, new URL(object.id, calendar.providerCalendarId).href, 'DELETE', { 'if-match': object.etag });
    return { upserts: [], deletes: [object.id] };
  },
};
