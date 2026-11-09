/**
 * The shell's line icons (24×24, drawn with `currentColor`), from the approved design's symbol set.
 * `<Icon name="calendar" />` is decorative; give the surrounding control its accessible name.
 */
import type { ReactNode } from 'react';
import { cx } from './cx.ts';

const PATHS = {
  chevron: <path d="m6 9 6 6 6-6" />,
  'chevron-left': <path d="m15 6-6 6 6 6" />,
  'chevron-right': <path d="m9 6 6 6-6 6" />,
  close: <path d="M6 6l12 12M18 6 6 18" />,
  grip: <path d="M9 5h.01M9 12h.01M9 19h.01M15 5h.01M15 12h.01M15 19h.01" strokeWidth={3} />,
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-4-4" />
    </>
  ),
  calendar: (
    <>
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <path d="M7 2v5m10-5v5M3 9h18" />
    </>
  ),
  'calendar-plus': (
    <>
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <path d="M7 2v5m10-5v5M3 9h18M12 12v7m-3.5-3.5h7" />
    </>
  ),
  layers: <path d="m3 8 9-5 9 5-9 5-9-5Zm0 4 9 5 9-5M3 16l9 5 9-5" />,
  home: <path d="m3 10 9-8 9 8v11h-7v-7h-4v7H3Z" />,
  users: <path d="M2 20v-3c0-5 14-5 14 0v3M9 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm7-6c5-1 6 7 1 7m2 4c3 0 3 3 3 6" />,
  eye: (
    <>
      <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12Z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  link: <path d="m9 15 6-6m-5 8-3 3a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0m2-2 3-3a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0" />,
  gear: (
    <>
      <path d="m9 3 1-2h4l1 3 3 1 3 1 1 4-2 2 1 3-1 3-3 1-2 3h-4l-1-3-3-1-3-1-1-4 2-2-1-3 1-3 3-1Z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  shield: <path d="m12 2 9 4v7c0 5-9 9-9 9S3 18 3 13V6Zm-4 9 3 3 5-6" />,
  copy: (
    <>
      <rect x="8" y="6" width="13" height="16" rx="1" />
      <path d="M16 6V2H3v16h5" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  check: <path d="m5 12 5 5 9-10" />,
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof PATHS;

export function Icon({ name, className }: { name: IconName; className?: string }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cx('size-5 shrink-0', className)}
    >
      {PATHS[name]}
    </svg>
  );
}
