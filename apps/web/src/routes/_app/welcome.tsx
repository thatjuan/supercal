/**
 * Onboarding (docs/product.md screen 2), where Overview sends a user without accounts: connect a
 * first account, watch its calendars appear as discovery runs (the live stream refreshes the
 * calendar query), choose what to publish, then go to Subscribe. OAuth providers return here with
 * `?accountId=…`.
 */
import { useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useState, type ReactNode } from 'react';
import { $api } from '../../api.ts';
import { useNow } from '../../components/accounts/account-list.tsx';
import { ConnectDialog } from '../../components/accounts/connect-dialog.tsx';
import { accountsQuery, instanceQuery, useDefaultPublications, useOAuth, useTogglePublication } from '../../components/accounts/data.ts';
import { accountHealth, timeAgo, type Calendar, type Provider } from '../../components/accounts/health.ts';
import { oauthSearch, oauthToast, type OAuthSearch } from '../../components/accounts/oauth-return.ts';
import { ProviderPicker } from '../../components/accounts/provider-picker.tsx';
import { isOAuth, PROVIDERS, ProviderMark, type FormProvider } from '../../components/accounts/providers.tsx';
import { StatusBadge, StatusMessage } from '../../components/accounts/status.tsx';
import { ToastProvider, useToast } from '../../components/accounts/toast.tsx';
import { PageHeader } from '../../components/page-header.tsx';
import { ColorChip } from '../../components/ui/calendar-color.tsx';
import { cx } from '../../components/ui/cx.ts';
import { Icon } from '../../components/ui/icon.tsx';
import { Switch } from '../../components/ui/switch.tsx';
import { toProblem } from '../../components/ui/problem-alert.tsx';

export const Route = createFileRoute('/_app/welcome')({
  validateSearch: (search): OAuthSearch => oauthSearch(search),
  component: () => (
    <ToastProvider>
      <Welcome />
    </ToastProvider>
  ),
});

/** Until the Subscribe screen (#20) has a route, its address. */
const SUBSCRIBE_HREF = '/feeds/default/subscribe';

function Step({ number, title, done, children }: { number: number; title: string; done?: boolean; children?: ReactNode }) {
  return (
    <li className="grid grid-cols-[2rem_1fr] gap-x-4">
      <span
        aria-hidden
        className={cx('grid size-8 place-items-center rounded-full text-sm font-semibold', done ? 'bg-accent text-accent-ink' : 'border border-line-strong bg-surface text-ink-2')}
      >
        {done ? <Icon name="check" className="size-4" /> : number}
      </span>
      <div className="min-w-0 pb-8">
        <h2 className="mt-0.5 text-[22px] font-semibold tracking-tight">{title}</h2>
        {children && <div className="mt-3">{children}</div>}
      </div>
    </li>
  );
}

function Welcome() {
  const toast = useToast();
  const search = Route.useSearch();
  const instance = useQuery(instanceQuery);
  const [form, setForm] = useState<FormProvider | null>(null);
  const [accountId, setAccountId] = useState(search.accountId);
  const oauth = useOAuth((error) => toast({ tone: 'error', message: toProblem(error).detail ?? toProblem(error).title }));

  useEffect(() => {
    const notice = oauthToast(search);
    if (search.error && notice) toast(notice);
  }, [search, toast]);

  const pick = (provider: Provider) => (isOAuth(provider) ? oauth.connect(provider, '/welcome?connected=1') : setForm(provider));

  return (
    <>
      <PageHeader title="Welcome" />
      <ol className="max-w-3xl">
        <Step number={1} title={accountId ? 'Calendar connected' : 'Connect your first calendar'} done={!!accountId}>
          {accountId ? (
            <ConnectedAccount accountId={accountId} />
          ) : (
            <>
              <p className="mb-4 text-[15px] text-ink-2">Supercal reads your calendars from where they live. Pick a provider to start; you can add more later.</p>
              <ProviderPicker instance={instance.data} onPick={pick} disabled={oauth.pending} />
            </>
          )}
        </Step>
        <Step number={2} title="Choose what to publish" done={false}>
          {accountId ? (
            <DiscoveredCalendars accountId={accountId} />
          ) : (
            <p className="text-[15px] text-ink-3">Your calendars appear here as Supercal finds them.</p>
          )}
        </Step>
        <Step number={3} title="Add it to your calendar app">
          <p className="mb-3 text-[15px] text-ink-2">One subscription shows every published calendar in Apple Calendar, Outlook, Google Calendar or any CalDAV app.</p>
          <a
            href={SUBSCRIBE_HREF}
            aria-disabled={!accountId}
            className={cx(
              'inline-flex h-9 items-center rounded-[9px] px-4 text-[15px] font-medium shadow-xs',
              accountId ? 'bg-accent text-accent-ink hover:opacity-90' : 'pointer-events-none border border-line bg-surface text-ink-3',
            )}
            {...(!accountId && { tabIndex: -1 })}
          >
            Add it to your calendar app
          </a>
        </Step>
      </ol>
      <ConnectDialog
        provider={form}
        onOpenChange={(open) => !open && setForm(null)}
        onDone={(account) => {
          setForm(null);
          setAccountId(account.id);
        }}
      />
    </>
  );
}

/** The account just connected, with its live health. */
function ConnectedAccount({ accountId }: { accountId: string }) {
  const accounts = useQuery(accountsQuery);
  const calendars = $api.useQuery('get', '/api/v1/calendars', { params: { query: { accountId } } }, { select: (data) => ({ items: data.items.filter((calendar) => calendar.kind === 'connected') }) });
  const now = useNow();
  const account = accounts.data?.items.find((item) => item.id === accountId);
  if (!account) return null;
  return (
    <div className="grid gap-2 rounded-[14px] border border-line bg-surface px-5 py-4 shadow-xs">
      <div className="flex flex-wrap items-center gap-3">
        <ProviderMark provider={account.provider} className="size-6" />
        <p className="min-w-0 flex-1 text-[15px]">
          <span className="font-semibold">{account.displayName}</span>
          <span className="text-ink-3"> · {PROVIDERS[account.provider].name}</span>
        </p>
        <StatusBadge health={accountHealth(account, calendars.data?.items ?? [], undefined, now)} />
      </div>
      <StatusMessage account={account} />
      <p className="text-[13px] text-ink-3">
        <a href="/accounts" className="text-accent-text hover:underline">
          Manage accounts
        </a>{' '}
        to add another or change this one.
      </p>
    </div>
  );
}

/** The account's calendars, appearing live, each with its publish toggle (on by default). */
function DiscoveredCalendars({ accountId }: { accountId: string }) {
  const toast = useToast();
  const now = useNow();
  const calendars = $api.useQuery('get', '/api/v1/calendars', { params: { query: { accountId } } }, { select: (data) => ({ items: data.items.filter((calendar) => calendar.kind === 'connected') }) });
  const publications = useDefaultPublications();
  const toggle = useTogglePublication((error) => toast({ tone: 'error', message: `Could not save: ${toProblem(error).detail ?? toProblem(error).title}` }));
  const items = (calendars.data?.items ?? []).filter((calendar) => calendar.state === 'active');
  const publicationOf = (calendar: Calendar) =>
    publications.data?.items.find((item) => item.kind === 'passthrough' && item.sourceCalendarId === calendar.id);

  if (items.length === 0) {
    return (
      <p aria-live="polite" className="flex items-center gap-2 text-[15px] text-ink-2">
        <span aria-hidden className="size-2.5 animate-pulse rounded-full bg-accent" />
        Looking for calendars…
      </p>
    );
  }
  return (
    <ul aria-label="Discovered calendars" className="divide-y divide-line rounded-[14px] border border-line bg-surface shadow-xs">
      {items.map((calendar) => {
        const publication = publicationOf(calendar);
        const { lastSuccessAt } = calendar.freshness;
        return (
          <li key={calendar.id} className="flex items-center gap-3 px-5 py-3">
            <ColorChip color={calendar.color ?? 'var(--line-strong)'} />
            <span className="min-w-0 flex-1 truncate text-[15px]">{calendar.name}</span>
            <span className="text-[13px] text-ink-3">{lastSuccessAt ? `synced ${timeAgo(Date.parse(lastSuccessAt), now)}` : 'syncing…'}</span>
            <Switch
              aria-label={`Publish ${calendar.name}`}
              checked={publication?.enabled ?? true}
              disabled={!publication}
              onCheckedChange={(enabled) => publication && toggle.mutate({ params: { path: { id: publication.id } }, body: { enabled } })}
            />
          </li>
        );
      })}
    </ul>
  );
}
