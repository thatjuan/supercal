/**
 * Calendar colours (user data) in the UI: `ColorChip` is the swatch beside a calendar's name, and
 * `EventBlock` an event in its calendar's colour, with text kept legible in both themes by `eventColors`.
 */
import type { ReactNode } from 'react';
import { eventColors } from '../../lib/color.ts';
import { useTheme } from '../../theme.ts';
import { cx } from './cx.ts';

export function ColorChip({ color, className }: { color: string; className?: string }) {
  return <span aria-hidden className={cx('inline-block size-[18px] shrink-0 rounded-[5px] ring-1 ring-black/5 ring-inset', className)} style={{ background: color }} />;
}

export function EventBlock({ color, title, meta, className }: { color: string; title: ReactNode; meta?: ReactNode; className?: string }) {
  const { resolved } = useTheme();
  const { background, text, accent } = eventColors(color, resolved);
  return (
    <div className={cx('rounded-md border-l-[3px] px-2 py-1 text-xs leading-snug', className)} style={{ background, color: text, borderColor: accent }}>
      <p className="truncate font-medium">{title}</p>
      {meta && <p className="truncate">{meta}</p>}
    </div>
  );
}
