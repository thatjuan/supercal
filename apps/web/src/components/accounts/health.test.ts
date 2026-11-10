import { describe, expect, test } from 'vitest';
import { accountHealth, statusMessage, SYNC_COOLDOWN_MS, type Account, type Calendar } from './health.ts';

const account = (patch: Partial<Account> = {}): Account => ({
  id: 'acc_1',
  provider: 'caldav',
  ownerUserId: 'user_1',
  displayName: 'Home',
  email: null,
  serverUrl: 'https://dav.example/',
  status: 'active',
  statusDetail: null,
  autoPublish: true,
  ...patch,
});

const calendar = (lastSuccessAt: number | null, state: Calendar['state'] = 'active'): Calendar => ({
  id: 'cal_1',
  kind: 'connected',
  access: 'owner',
  owner: { id: 'user_1', name: 'Owner' },
  description: null,
  sortOrder: 0,
  updatedAt: '2026-11-08T00:00:00Z',
  goneAt: null,
  accountId: 'acc_1',
  name: 'Work',
  color: null,
  timezone: null,
  state,
  capabilities: { incremental: 'sync-token', push: false, write: false },
  freshness: { lastSuccessAt: lastSuccessAt === null ? null : new Date(lastSuccessAt).toISOString(), pushActive: false, expectedLatency: 900, stale: false },
  publicationIds: [],
});

describe('accountHealth', () => {
  const now = 1_000_000_000;

  test('a stored problem status wins over syncing', () => {
    expect(accountHealth(account({ status: 'reauth_required' }), [calendar(null)], now, now)).toBe('reauth_required');
  });

  test('syncing while a live calendar has never synced; a gone one does not count', () => {
    expect(accountHealth(account(), [calendar(now - 5_000), calendar(null)], undefined, now)).toBe('syncing');
    expect(accountHealth(account(), [calendar(now - 5_000), calendar(null, 'gone')], undefined, now)).toBe('active');
  });

  test('syncing after Sync now until a newer success or the cooldown ends', () => {
    const requested = now - 1_000;
    expect(accountHealth(account(), [calendar(now - 60_000)], requested, now)).toBe('syncing');
    expect(accountHealth(account(), [calendar(now - 500)], requested, now)).toBe('active');
    expect(accountHealth(account(), [calendar(now - 60_000)], requested, requested + SYNC_COOLDOWN_MS)).toBe('active');
  });
});

describe('statusMessage', () => {
  const GOOGLE_TESTING =
    'Google rejected the refresh token (invalid_grant), so the account needs to be reconnected. If this keeps happening about every 7 days, the Google OAuth app is in Testing publishing status, where refresh tokens expire after 7 days: publish it to Production.';

  test('Google’s 7-day Testing expiry names the operator’s fix', () => {
    const message = statusMessage({ provider: 'google', status: 'reauth_required', statusDetail: GOOGLE_TESTING });
    expect(message).toContain('Testing mode');
    expect(message).toContain('ask the operator to publish the app');
  });

  test('other reauth details are quoted after a plain explanation', () => {
    for (const provider of ['microsoft', 'caldav'] as const) {
      const message = statusMessage({ provider, status: 'reauth_required', statusDetail: '401 Unauthorized' });
      expect(message).toContain('Reconnect to resume');
      expect(message).toContain('“401 Unauthorized”');
      expect(message).not.toContain('Testing mode');
    }
    expect(statusMessage({ provider: 'google', status: 'reauth_required', statusDetail: null })).not.toContain('said');
  });

  test('errors and disabled accounts explain themselves; active ones say nothing', () => {
    expect(statusMessage({ provider: 'ics', status: 'error', statusDetail: 'HTTP 500' })).toContain('Syncing failed: HTTP 500');
    expect(statusMessage({ provider: 'ics', status: 'disabled', statusDetail: null })).toContain('disabled');
    expect(statusMessage({ provider: 'ics', status: 'active', statusDetail: null })).toBeNull();
  });
});
