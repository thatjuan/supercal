import { cx } from './ui/cx.ts';

/** The Supercal name, set as the design's wordmark: heavy, tight, no mark. */
export function Wordmark({ className }: { className?: string }) {
  return <span className={cx('block text-[28px] leading-none font-bold tracking-[-0.04em] text-ink', className)}>Supercal</span>;
}
