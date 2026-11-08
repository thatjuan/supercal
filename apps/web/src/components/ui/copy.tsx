/**
 * Copy-to-clipboard controls. `CopyButton` copies `value` and confirms with "Copied" (announced to
 * screen readers) for a moment; `CopyField` shows a value read-only beside its copy button, with
 * room for extra actions such as a QR code.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { Button } from './button.tsx';
import { cx } from './cx.ts';
import { Icon } from './icon.tsx';

const CONFIRM_MS = 2000;

/** Copies `value`; `label` names what is copied for assistive tech ("Copy CalDAV password"). */
export function CopyButton({ value, label = 'Copy', className }: { value: string; label?: string; className?: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');

  useEffect(() => {
    if (state === 'idle') return;
    const timer = setTimeout(() => setState('idle'), CONFIRM_MS);
    return () => clearTimeout(timer);
  }, [state]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setState('copied');
    } catch {
      setState('failed');
    }
  }

  return (
    <Button size="sm" aria-label={label} onClick={() => void copy()} className={cx('min-w-[5.5rem]', className)}>
      <Icon name={state === 'copied' ? 'check' : 'copy'} className={cx('size-4', state === 'copied' && 'text-accent')} />
      <span role="status" aria-live="polite">
        {state === 'copied' ? 'Copied' : state === 'failed' ? 'Select it' : 'Copy'}
      </span>
    </Button>
  );
}

/** A labelled, read-only value (a URL, username or secret) with a copy button and optional `actions`. */
export function CopyField({ label, value, copyLabel, actions }: { label: string; value: string; copyLabel?: string; actions?: ReactNode }) {
  return (
    <div className="grid min-w-0 gap-1">
      <span className="text-[13px] font-semibold text-ink-2">{label}</span>
      <div className="flex min-w-0 items-center gap-2">
        <input
          readOnly
          value={value}
          aria-label={label}
          onFocus={(event) => event.currentTarget.select()}
          className="h-9 min-w-0 flex-1 truncate rounded-lg border border-line bg-surface-2 px-3 font-mono text-[13px] text-ink"
        />
        <CopyButton value={value} label={copyLabel ?? `Copy ${label}`} />
        {actions}
      </div>
    </div>
  );
}
