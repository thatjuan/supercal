/**
 * The account providers as the UI shows them: name, how they connect (`oauth` through the
 * provider's consent screen, or a credential form), and a small mark. Google and Microsoft are
 * available only when the operator configured them (`instance.providers`).
 */
import type { components } from '@supercal/api-client';
import type { ReactNode } from 'react';
import { cx } from '../ui/cx.ts';
import { Icon } from '../ui/icon.tsx';
import type { Provider } from './health.ts';

type Instance = components['schemas']['Instance'];

export const PROVIDERS = {
  google: { name: 'Google', blurb: 'Gmail and Google Workspace calendars', connect: 'oauth' },
  microsoft: { name: 'Microsoft', blurb: 'Microsoft 365 and Outlook.com', connect: 'oauth' },
  icloud: { name: 'iCloud', blurb: 'Apple calendars, with an app-specific password', connect: 'form' },
  caldav: { name: 'Other CalDAV', blurb: 'Fastmail, Nextcloud, Yahoo, Zoho and more', connect: 'form' },
  ics: { name: 'ICS link', blurb: 'A read-only calendar link (.ics or webcal://)', connect: 'form' },
} as const satisfies Record<Provider, { name: string; blurb: string; connect: 'oauth' | 'form' }>;

export type OAuthProvider = { [P in Provider]: (typeof PROVIDERS)[P]['connect'] extends 'oauth' ? P : never }[Provider];
export type FormProvider = Exclude<Provider, OAuthProvider>;

export const PROVIDER_ORDER = ['google', 'microsoft', 'icloud', 'caldav', 'ics'] as const satisfies readonly Provider[];

export const isOAuth = (provider: Provider): provider is OAuthProvider => PROVIDERS[provider].connect === 'oauth';

/** Whether this server can connect `provider`: OAuth providers need the operator's client credentials. */
export const isAvailable = (provider: Provider, instance: Instance | undefined): boolean => (isOAuth(provider) ? (instance?.providers[provider] ?? false) : true);

const MARKS: Record<Provider, ReactNode> = {
  google: (
    <svg viewBox="0 0 24 24" aria-hidden className="size-full">
      <path fill="#4285F4" d="M21.6 12.2c0-.7-.1-1.4-.2-2H12v3.8h5.4a4.6 4.6 0 0 1-2 3v2.5h3.2c1.9-1.7 3-4.3 3-7.3Z" />
      <path fill="#34A853" d="M12 22c2.7 0 5-.9 6.6-2.5l-3.2-2.5c-.9.6-2 1-3.4 1-2.6 0-4.8-1.8-5.6-4.1H3.1v2.6A10 10 0 0 0 12 22Z" />
      <path fill="#FBBC05" d="M6.4 13.9a6 6 0 0 1 0-3.8V7.5H3.1a10 10 0 0 0 0 9Z" />
      <path fill="#EA4335" d="M12 6c1.5 0 2.8.5 3.8 1.5l2.9-2.9A10 10 0 0 0 3.1 7.5l3.3 2.6C7.2 7.8 9.4 6 12 6Z" />
    </svg>
  ),
  microsoft: (
    <svg viewBox="0 0 24 24" aria-hidden className="size-full">
      <path fill="#F25022" d="M3 3h8.5v8.5H3z" />
      <path fill="#7FBA00" d="M12.5 3H21v8.5h-8.5z" />
      <path fill="#00A4EF" d="M3 12.5h8.5V21H3z" />
      <path fill="#FFB900" d="M12.5 12.5H21V21h-8.5z" />
    </svg>
  ),
  icloud: (
    <svg viewBox="0 0 24 24" aria-hidden fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinejoin="round" className="size-full text-info">
      <path d="M7 18h10.5a4 4 0 0 0 .4-8 5.5 5.5 0 0 0-10.6-1.2A4.6 4.6 0 0 0 7 18Z" />
    </svg>
  ),
  caldav: <Icon name="calendar" className="size-full text-ink-2" />,
  ics: <Icon name="link" className="size-full text-ink-2" />,
};

/** The provider's mark, decorative: name the provider in text beside it. */
export function ProviderMark({ provider, className }: { provider: Provider; className?: string }) {
  return <span className={cx('inline-flex size-5 shrink-0', className)}>{MARKS[provider]}</span>;
}
