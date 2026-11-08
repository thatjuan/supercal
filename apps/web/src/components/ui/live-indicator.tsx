import type { LiveStatus } from '../../live.ts';
import { cx } from './cx.ts';

const LABEL: Record<LiveStatus, string> = { connecting: 'Connecting…', live: 'Live', reconnecting: 'Reconnecting…' };

/** The shell's stream status: a green pill when live, amber while (re)connecting, announced politely when it changes. */
export function LiveIndicator({ status, className }: { status: LiveStatus; className?: string }) {
  const live = status === 'live';
  return (
    <span
      className={cx(
        'inline-flex h-6 w-max items-center gap-2 rounded-full pr-2.5 pl-2 text-[13px]',
        live ? 'bg-accent-soft text-accent-text' : 'bg-warning-soft text-warning',
        className,
      )}
    >
      <span aria-hidden className={cx('size-2.5 rounded-full', live ? 'bg-accent' : 'animate-pulse bg-warning')} />
      <span role="status" aria-live="polite">
        {LABEL[status]}
      </span>
    </span>
  );
}
