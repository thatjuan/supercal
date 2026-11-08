/** Guarded outbound transport: the SSRF boundary for every user-influenced fetch. */
export { createGuardedFetch, hostMatches, type GuardedFetch, type GuardedFetchOptions, type GuardedRequest, type GuardedResponse } from './guarded-fetch.ts';
export { type EgressBlockReason, EgressBlockedError, type EgressPolicy, type Resolver } from './policy.ts';
