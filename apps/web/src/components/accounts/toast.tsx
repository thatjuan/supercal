/**
 * Short-lived notices for the account screens ("Google connected", a failed rename). Wrap a screen
 * in `ToastProvider`; anything inside calls `useToast()({ tone, message })`. Notices are announced
 * politely and dismiss themselves after `TOAST_MS`.
 */
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { cx } from '../ui/cx.ts';

type Toast = { tone: 'success' | 'error'; message: string };

export const TOAST_MS = 6_000;

const ToastContext = createContext<(toast: Toast) => void>(() => {});

export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<(Toast & { at: number }) | null>(null);
  const show = useCallback((next: Toast) => setToast({ ...next, at: Date.now() }), []);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast]);

  return (
    <ToastContext value={show}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed right-4 bottom-4 z-50 flex max-w-sm justify-end">
        {toast && (
          <p
            key={toast.at}
            className={cx(
              'pointer-events-auto rounded-[10px] border px-4 py-2.5 text-sm shadow-lg shadow-black/10',
              toast.tone === 'success' ? 'border-accent/30 bg-accent-soft text-accent-text' : 'border-danger/30 bg-danger-soft text-danger',
            )}
          >
            {toast.message}
          </p>
        )}
      </div>
    </ToastContext>
  );
}
