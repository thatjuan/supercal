/** The Microsoft 365 / Outlook.com provider. The daemon registers `createMicrosoftAdapter` when `MICROSOFT_CLIENT_ID`/`MICROSOFT_CLIENT_SECRET` are set. */
export { createMicrosoftAdapter, type MicrosoftAdapterOptions, type MicrosoftCursor } from './adapter.ts';
export { GRAPH_API, MICROSOFT_AUTHORITY, MICROSOFT_REAUTH_DETAIL, MICROSOFT_SCOPES, MICROSOFT_TOKEN_URL, type MicrosoftClientOptions } from './api.ts';
