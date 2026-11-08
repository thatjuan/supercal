import type { ReactNode } from 'react';
import { cx } from './cx.ts';

const TONES = {
  neutral: 'bg-surface-2 text-ink',
  accent: 'bg-accent-soft text-accent-text',
  info: 'bg-info-soft text-info',
  violet: 'bg-violet-soft text-violet',
  warning: 'bg-warning-soft text-warning',
  danger: 'bg-danger-soft text-danger',
} as const;

/** A small pill label: an account's health, a privacy level (`accent` Full, `info` Title only, `violet` Busy only), a membership chip. */
export function Badge({ tone = 'neutral', children, className }: { tone?: keyof typeof TONES; children: ReactNode; className?: string }) {
  return <span className={cx('inline-flex h-6 w-max items-center rounded-full px-3 text-[13px]', TONES[tone], className)}>{children}</span>;
}
