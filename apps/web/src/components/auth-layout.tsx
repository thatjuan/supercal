import type { ReactNode } from 'react';
import { Wordmark } from './wordmark.tsx';

/** The frame for signed-out screens: the wordmark over one narrow panel. */
export function AuthLayout({ title, subtitle, children, footer }: { title: string; subtitle?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  return (
    <main className="grid min-h-full place-items-center px-4 py-12">
      <div className="w-full max-w-[24rem]">
        <Wordmark className="mb-8 text-center" />
        <div className="rounded-[14px] border border-line bg-surface p-6 shadow-xs">
          <h1 className="text-[22px] font-semibold tracking-tight">{title}</h1>
          {subtitle && <p className="mt-0.5 text-[15px] text-ink-2">{subtitle}</p>}
          <div className="mt-5">{children}</div>
        </div>
        {footer && <div className="mt-4 text-center text-sm text-ink-2">{footer}</div>}
      </div>
    </main>
  );
}
