/** The Google Calendar provider. The daemon registers `createGoogleAdapter` when `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` are set. */
export { createGoogleAdapter, type GoogleAdapterOptions, type GoogleCursor } from './adapter.ts';
export { GOOGLE_API, GOOGLE_INVALID_GRANT_DETAIL, GOOGLE_TOKEN_URL, type GoogleClientOptions } from './api.ts';
