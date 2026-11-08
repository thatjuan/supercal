import { useId, type ComponentProps } from 'react';
import { cx } from './cx.ts';

/** A text input. Pair it with `Field` for a label and errors. */
export function Input({ className, ...props }: ComponentProps<'input'>) {
  return (
    <input
      className={cx(
        'h-10 w-full rounded-lg border border-line-strong bg-surface px-3.5 text-[15px] text-ink shadow-xs placeholder:text-ink-3',
        'focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/25 aria-invalid:border-danger',
        className,
      )}
      {...props}
    />
  );
}

type FieldProps = ComponentProps<'input'> & { label: string; error?: string | undefined; hint?: string };

/** A labelled input with an optional hint and a field error (from `fieldErrors(problem)`). */
export function Field({ label, error, hint, id, ...props }: FieldProps) {
  const fallbackId = useId();
  const inputId = id ?? fallbackId;
  const noteId = `${inputId}-note`;
  const note = error ?? hint;
  return (
    <div className="grid gap-1.5">
      <label htmlFor={inputId} className="text-sm font-semibold text-ink">
        {label}
      </label>
      <Input id={inputId} aria-invalid={error ? true : undefined} aria-describedby={note ? noteId : undefined} {...props} />
      {note && (
        <p id={noteId} className={cx('text-[13px]', error ? 'text-danger' : 'text-ink-3')}>
          {note}
        </p>
      )}
    </div>
  );
}
