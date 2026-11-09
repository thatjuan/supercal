import type { ReactNode } from 'react';
import { cx } from './cx.ts';

/** A white hairline card with a title row (title, optional description and actions), as in the approved shell. */
export function Panel({ id, title, description, actions, children, className }: { id?: string; title: string; description?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section id={id} aria-label={title} className={cx('rounded-[14px] border border-line bg-surface shadow-xs', className)}>
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-4 py-3.5 sm:px-5">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
          {description && <p className="mt-0.5 text-sm text-ink-2">{description}</p>}
        </div>
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </header>
      <div className="px-4 py-4 sm:px-5">{children}</div>
    </section>
  );
}
