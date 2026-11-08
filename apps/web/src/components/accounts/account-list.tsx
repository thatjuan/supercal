/**
 * The Accounts screen's list: one row per account with its health, freshness and actions (Sync
 * now, Rename, Reconnect, Remove), and a detail drawer with the auto-publish toggle and its
 * calendars. Reconnecting is the screen's: it differs per provider (`onReconnect`).
 */
import { Dialog as Primitive } from 'radix-ui';
import { useEffect, useState } from 'react';
import { $api, isProblem } from '../../api.ts';
import { Button } from '../ui/button.tsx';
import { ColorChip } from '../ui/calendar-color.tsx';
import { cx } from '../ui/cx.ts';
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '../ui/menu.tsx';
import { Switch } from '../ui/switch.tsx';
import { RemoveDialog, RenameDialog } from './account-dialogs.tsx';
import { useUpdateAccount } from './data.ts';
import { accountFreshness, accountHealth, SYNC_COOLDOWN_MS, timeAgo, type Account, type Calendar } from './health.ts';
import { PROVIDERS, ProviderMark } from './providers.tsx';
import { StatusBadge, StatusMessage } from './status.tsx';
import { useToast } from './toast.tsx';

/** The current time, re-read every `everyMs`, so relative times and cooldowns move on their own. */
export function useNow(everyMs = 15_000): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [everyMs]);
  return now;
}

/** The account's email, or else its server's host (ICS accounts store only the host). */
export const accountAddress = ({ email, serverUrl }: Pick<Account, 'email' | 'serverUrl'>) => email ?? (serverUrl ? (URL.parse(serverUrl)?.host ?? serverUrl) : null);

/** "synced 2 min ago · push active · 4 calendars", breaking only between its parts. */
function FreshnessLine({ calendars, now, className }: { calendars: readonly Calendar[]; now: number; className?: string }) {
  const { lastSuccessAt, pushActive, pollMinutes, calendarCount } = accountFreshness(calendars);
  const parts = [
    lastSuccessAt === null ? 'not synced yet' : `synced ${timeAgo(lastSuccessAt, now)}`,
    pushActive ? 'push active' : pollMinutes !== null ? `polling every ${pollMinutes} min` : null,
    `${calendarCount} calendar${calendarCount === 1 ? '' : 's'}`,
  ].filter((part) => part !== null);
  return (
    <p className={cx('text-[13px] text-ink-2 tabular-nums', className)}>
      {parts.map((part, index) => (
        <span key={part} className="whitespace-nowrap">
          {index > 0 && ' · '}
          {part}
        </span>
      ))}
    </p>
  );
}

function calendarFreshness(calendar: Calendar, now: number): string {
  if (calendar.state === 'gone') return 'no longer at the provider';
  const { lastSuccessAt, stale } = calendar.freshness;
  const synced = lastSuccessAt ? `synced ${timeAgo(Date.parse(lastSuccessAt), now)}` : 'not synced yet';
  return stale ? `${synced} · paused, last good data still published` : synced;
}

type RowProps = { account: Account; calendars: Calendar[]; onReconnect: (account: Account) => void };

export function AccountRow({ account, calendars, onReconnect }: RowProps) {
  const toast = useToast();
  const now = useNow(1_000);
  const [syncRequestedAt, setSyncRequestedAt] = useState<number>();
  const [dialog, setDialog] = useState<'rename' | 'remove' | 'details' | null>(null);
  const update = useUpdateAccount((error) => toast({ tone: 'error', message: `Could not save: ${isProblem(error) ? (error.detail ?? error.title) : 'Supercal could not be reached'}` }));
  const sync = $api.useMutation('post', '/api/v1/accounts/{id}/sync', {
    onMutate: () => setSyncRequestedAt(Date.now()),
    onError: (error) => {
      if (isProblem(error) && error.status === 429) return toast({ tone: 'error', message: 'A sync started less than 30 seconds ago. Try again shortly.' });
      setSyncRequestedAt(undefined);
      toast({ tone: 'error', message: isProblem(error) ? (error.detail ?? error.title) : 'Supercal could not be reached' });
    },
  });

  const health = accountHealth(account, calendars, syncRequestedAt, now);
  const coolingDown = syncRequestedAt !== undefined && now - syncRequestedAt < SYNC_COOLDOWN_MS;
  const address = accountAddress(account);
  const patch = (body: { displayName?: string; autoPublish?: boolean }) => update.mutate({ params: { path: { id: account.id } }, body });

  return (
    <li className="grid gap-2 border-t border-line px-5 py-4 first:border-t-0">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <ProviderMark provider={account.provider} className="size-6" />
        <div className="min-w-0 flex-1 basis-56">
          <button type="button" onClick={() => setDialog('details')} className="max-w-full truncate text-left text-[15px] font-semibold hover:underline focus-visible:underline focus-visible:outline-none">
            {account.displayName}
          </button>
          <p className="truncate text-[13px] text-ink-3">
            {PROVIDERS[account.provider].name}
            {address && ` · ${address}`}
          </p>
        </div>
        <StatusBadge health={health} />
        <FreshnessLine calendars={calendars} now={now} className="basis-64" />
        <div className="flex items-center gap-1.5">
          <Button size="sm" disabled={coolingDown || account.status === 'disabled' || account.status === 'reauth_required'} onClick={() => sync.mutate({ params: { path: { id: account.id } } })}>
            {coolingDown ? `Sync again in ${Math.ceil((SYNC_COOLDOWN_MS - (now - (syncRequestedAt ?? now))) / 1000)} s` : 'Sync now'}
          </Button>
          <Menu>
            <MenuTrigger asChild>
              <Button size="sm" aria-label={`More actions for ${account.displayName}`} className="w-8 px-0">
                <span aria-hidden className="text-base leading-none tracking-wider">···</span>
              </Button>
            </MenuTrigger>
            <MenuContent align="end">
              <MenuItem onSelect={() => setDialog('details')}>Details</MenuItem>
              <MenuItem onSelect={() => setDialog('rename')}>Rename</MenuItem>
              <MenuItem onSelect={() => onReconnect(account)}>Reconnect</MenuItem>
              <MenuSeparator />
              <MenuItem className="text-danger" onSelect={() => setDialog('remove')}>
                Remove
              </MenuItem>
            </MenuContent>
          </Menu>
        </div>
      </div>
      {account.status !== 'active' && (
        <div className="flex flex-wrap items-start gap-3 pl-10">
          <StatusMessage account={account} className="max-w-prose flex-1" />
          {account.status === 'reauth_required' && (
            <Button size="sm" variant="primary" onClick={() => onReconnect(account)}>
              Reconnect
            </Button>
          )}
        </div>
      )}

      {dialog === 'rename' && <RenameDialog account={account} open onOpenChange={() => setDialog(null)} onRename={(displayName) => patch({ displayName })} />}
      <RemoveDialog account={account} calendars={calendars} open={dialog === 'remove'} onOpenChange={(open) => setDialog(open ? 'remove' : null)} onRemoved={() => toast({ tone: 'success', message: `${account.displayName} removed` })} />
      <AccountDrawer
        account={account}
        calendars={calendars}
        now={now}
        open={dialog === 'details'}
        onOpenChange={(open) => setDialog(open ? 'details' : null)}
        onAutoPublish={(autoPublish) => patch({ autoPublish })}
      />
    </li>
  );
}

type DrawerProps = {
  account: Account;
  calendars: Calendar[];
  now: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAutoPublish: (on: boolean) => void;
};

/** A side sheet with the account's settings and its calendars, each linking to the Calendars screen. */
function AccountDrawer({ account, calendars, now, open, onOpenChange, onAutoPublish }: DrawerProps) {
  const switchId = `auto-publish-${account.id}`;
  return (
    <Primitive.Root open={open} onOpenChange={onOpenChange}>
      <Primitive.Portal>
        <Primitive.Overlay className="fixed inset-0 z-40 bg-black/30" />
        <Primitive.Content className="fixed inset-y-0 right-0 z-50 flex w-[min(30rem,100vw)] flex-col overflow-y-auto border-l border-line bg-surface shadow-xl">
          <header className="flex items-start gap-3 border-b border-line px-5 pt-5 pb-4">
            <ProviderMark provider={account.provider} className="mt-1 size-6" />
            <div className="min-w-0 flex-1">
              <Primitive.Title className="truncate text-lg font-semibold tracking-tight">{account.displayName}</Primitive.Title>
              <Primitive.Description className="truncate text-sm text-ink-3">
                {PROVIDERS[account.provider].name}
                {accountAddress(account) && ` · ${accountAddress(account)}`}
              </Primitive.Description>
            </div>
            <Primitive.Close asChild>
              <Button size="sm" variant="ghost" aria-label="Close">
                Close
              </Button>
            </Primitive.Close>
          </header>
          <div className="grid gap-5 px-5 py-4">
            <div className="flex items-center gap-3">
              <StatusBadge health={accountHealth(account, calendars, undefined, now)} />
              <FreshnessLine calendars={calendars} now={now} />
            </div>
            <StatusMessage account={account} />
            <div className="flex items-start justify-between gap-4 rounded-[12px] border border-line px-4 py-3">
              <div>
                <label htmlFor={switchId} className="text-[15px] font-semibold">
                  Auto-publish new calendars
                </label>
                <p className="text-[13px] text-ink-3">Calendars this account adds later are published in your feed straight away.</p>
              </div>
              <Switch id={switchId} checked={account.autoPublish} onCheckedChange={onAutoPublish} />
            </div>
            <section aria-labelledby={`${switchId}-calendars`}>
              <div className="mb-2 flex items-baseline justify-between">
                <h3 id={`${switchId}-calendars`} className="text-[15px] font-semibold">
                  Calendars
                </h3>
                <a href={`/calendars?accountId=${account.id}`} className="text-sm text-accent-text hover:underline">
                  Open in Calendars
                </a>
              </div>
              {calendars.length === 0 ? (
                <p className="text-sm text-ink-3">No calendars found yet.</p>
              ) : (
                <ul className="divide-y divide-line rounded-[12px] border border-line">
                  {calendars.map((calendar) => (
                    <li key={calendar.id} className={cx('flex items-center gap-3 px-4 py-2.5', calendar.state === 'gone' && 'opacity-60')}>
                      <ColorChip color={calendar.color ?? 'var(--line-strong)'} />
                      <a href={`/calendars?calendarId=${calendar.id}`} className="min-w-0 flex-1 truncate text-[15px] hover:underline">
                        {calendar.name}
                      </a>
                      <span className="text-[13px] text-ink-3">{calendarFreshness(calendar, now)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
}

