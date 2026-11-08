import type { ReactNode } from 'react';

/** A screen's large title with optional actions beside it; screen controls (such as a feed picker) go below it. */
export function PageHeader({ title, actions }: { title: string; actions?: ReactNode }) {
  return (
    <header className="mb-5 flex flex-wrap items-center justify-between gap-4">
      <h1 className="text-[44px] leading-tight font-bold tracking-[-0.03em]">{title}</h1>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </header>
  );
}
