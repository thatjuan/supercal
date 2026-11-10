/** Account-level consent is independent of individual calendar access roles. */
import { newId, parseTenantId } from '@supercal/db';
import { ProviderCredentials, GOOGLE_EVENTS_WRITE_SCOPE } from '@supercal/providers';
import { expect, test } from 'bun:test';
import { accountCanWrite } from '../src/api/accounts.ts';
import { testSecrets } from './auth-fixture.ts';

const account = { id: newId('acc'), tenantId: parseTenantId('org_write_scopes')!, credentials: null };

test('scope-free providers have fixed account consent semantics', async () => {
  for (const provider of ['caldav', 'icloud', 'hosted'] as const) expect(await accountCanWrite({ ...account, provider }, testSecrets)).toBe(true);
  expect(await accountCanWrite({ ...account, provider: 'ics' }, testSecrets)).toBe(false);
  expect(await accountCanWrite({ ...account, provider: 'google' }, testSecrets)).toBe(false);
});

test.each([
  ['google', [GOOGLE_EVENTS_WRITE_SCOPE], true],
  ['google', ['https://www.googleapis.com/auth/calendar.events.readonly'], false],
  ['microsoft', ['Calendars.ReadWrite'], true],
  ['microsoft', ['https://graph.microsoft.com/Calendars.ReadWrite'], true],
  ['microsoft', ['Calendars.Read'], false],
] as const)('%s consent comes from stored scopes %j', async (provider, scopes, expected) => {
  const token = { email: 'me@example.test', accessToken: 'access', refreshToken: 'refresh', accessTokenExpiresAt: '2027-01-01T00:00:00Z', scopes: [...scopes] };
  const value = provider === 'google' ? { ...token, provider, sub: 'sub' } : { ...token, provider, subject: 'tenant:user' };
  const credentials = await testSecrets.encryptJson(ProviderCredentials, value, { tenantId: account.tenantId, table: 'calendar_account', recordId: account.id, field: 'credentials' });
  expect(await accountCanWrite({ ...account, provider, credentials }, testSecrets)).toBe(expected);
});
