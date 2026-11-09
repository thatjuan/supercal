import type { ComponentProps } from 'react';
import { cx } from './cx.ts';

const VARIANTS = {
  primary: 'bg-accent text-accent-ink shadow-xs hover:opacity-90',
  secondary: 'border border-line bg-surface text-ink shadow-xs hover:bg-surface-2',
  ghost: 'text-ink-2 hover:bg-surface-2 hover:text-ink',
  danger: 'bg-danger text-surface shadow-xs hover:opacity-90',
} as const;

const SIZES = { sm: 'h-7 px-2.5 text-[13px]', md: 'h-9 px-4 text-[15px]' } as const;

export type ButtonProps = ComponentProps<'button'> & { variant?: keyof typeof VARIANTS; size?: keyof typeof SIZES };

/** A button's classes, for a link that should look like one. */
export const buttonClass = ({ variant = 'secondary', size = 'md', className }: { variant?: keyof typeof VARIANTS | undefined; size?: keyof typeof SIZES | undefined; className?: string | undefined } = {}) =>
  cx(
    'inline-flex items-center justify-center gap-1.5 rounded-[9px] font-medium whitespace-nowrap transition-colors disabled:pointer-events-none disabled:opacity-50',
    VARIANTS[variant],
    SIZES[size],
    className,
  );

/** The one button. `variant` defaults to `secondary`; `type` defaults to `button`, so forms opt in to `submit`. */
export function Button({ variant, size, className, type = 'button', ...props }: ButtonProps) {
  return <button type={type} className={buttonClass({ variant, size, className })} {...props} />;
}
