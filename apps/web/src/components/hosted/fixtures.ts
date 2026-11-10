/** Test data for the Hosted screens. */
import type { components } from '@supercal/api-client';
import type { HostedCalendar } from './data.ts';

export const ME_ID = 'user_me';
export const me: components['schemas']['Me'] = {
  user: { id: ME_ID, name: 'Ada', email: 'ada@example.invalid' },
  tenant: { id: 't1', name: 'Acme', slug: 'acme' },
  role: 'admin',
  isOperator: false,
  via: 'session',
  tenants: [],
};

export const hosted = (id: string, overrides: Partial<HostedCalendar> = {}): HostedCalendar => ({
  id,
  kind: 'hosted',
  writable: true,
  accountId: null,
  name: id,
  color: '#2f80ed',
  timezone: 'UTC',
  state: 'active',
  access: 'owner',
  owner: { id: ME_ID, name: 'Ada' },
  description: null,
  sortOrder: 0,
  updatedAt: '2026-11-08T00:00:00Z',
  goneAt: null,
  capabilities: { incremental: 'hosted', push: false, write: false },
  freshness: { lastSuccessAt: null, pushActive: false, expectedLatency: 0, stale: false },
  publicationIds: [],
  ...overrides,
});

/** A calendar as a `free-busy` grantee receives it: the API omits these fields. */
export function freeBusy(id: string, ownerName: string): HostedCalendar {
  const { description: _d, sortOrder: _s, updatedAt: _u, goneAt: _g, capabilities: _c, accountId: _a, ...rest } = hosted(id, { access: 'free-busy', owner: { id: `user_${ownerName}`, name: ownerName } });
  return rest;
}
