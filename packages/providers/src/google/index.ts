/**
 * The Google Calendar provider. The daemon registers `createGoogleAdapter` when `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` are set;
 * sinks call the API directly through `createGoogleApi`.
 */
export { createGoogleAdapter, SINK_CALENDAR_MARKER, type GoogleAdapterOptions, type GoogleCursor } from './adapter.ts';
export { createGoogleApi, GOOGLE_API, GOOGLE_INVALID_GRANT_DETAIL, GOOGLE_TOKEN_URL, GoogleHttpError, type GoogleApi, type GoogleClientOptions } from './api.ts';
