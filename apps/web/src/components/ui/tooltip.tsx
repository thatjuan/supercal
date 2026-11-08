/** A hover/focus hint (Radix). `TooltipProvider` is mounted once in the root route. */
import { Tooltip as Primitive } from 'radix-ui';
import type { ReactNode } from 'react';

export const TooltipProvider = Primitive.Provider;

export function Tooltip({ label, children, side = 'top' }: { label: ReactNode; children: ReactNode; side?: 'top' | 'right' | 'bottom' | 'left' }) {
  return (
    <Primitive.Root delayDuration={300}>
      <Primitive.Trigger asChild>{children}</Primitive.Trigger>
      <Primitive.Portal>
        <Primitive.Content side={side} sideOffset={6} className="z-50 rounded-md bg-ink px-2 py-1 text-xs text-surface shadow">
          {label}
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
}
