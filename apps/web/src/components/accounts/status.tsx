/** An account's health on screen: `StatusBadge` for the list, `StatusMessage` for the plain-words explanation under it. */
import { Badge } from '../ui/badge.tsx';
import { cx } from '../ui/cx.ts';
import { statusMessage, type Account, type AccountHealth } from './health.ts';

const BADGES = {
  active: { label: 'Active', tone: 'accent' },
  syncing: { label: 'Syncing', tone: 'info' },
  reauth_required: { label: 'Reconnect needed', tone: 'warning' },
  error: { label: 'Error', tone: 'danger' },
  disabled: { label: 'Disabled', tone: 'neutral' },
} as const satisfies Record<AccountHealth, { label: string; tone: Parameters<typeof Badge>[0]['tone'] }>;

export function StatusBadge({ health }: { health: AccountHealth }) {
  const { label, tone } = BADGES[health];
  return (
    <Badge tone={tone} className="gap-1.5 pl-2">
      <span aria-hidden className={cx('size-2 rounded-full bg-current', health === 'syncing' && 'animate-pulse')} />
      {label}
    </Badge>
  );
}

/** Why an account needs attention, in plain words; nothing for a healthy account. */
export function StatusMessage({ account, className }: { account: Pick<Account, 'provider' | 'status' | 'statusDetail'>; className?: string }) {
  const message = statusMessage(account);
  if (!message) return null;
  return <p className={cx('text-sm', account.status === 'reauth_required' ? 'text-warning' : account.status === 'error' ? 'text-danger' : 'text-ink-2', className)}>{message}</p>;
}
