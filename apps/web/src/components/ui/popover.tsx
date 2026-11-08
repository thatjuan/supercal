/** A non-modal popover (Radix), such as a colour picker. */
import { Popover as Primitive } from 'radix-ui';
import type { ComponentProps } from 'react';
import { cx } from './cx.ts';

export const Popover = Primitive.Root;
export const PopoverTrigger = Primitive.Trigger;

export function PopoverContent({ className, sideOffset = 6, ...props }: ComponentProps<typeof Primitive.Content>) {
  return (
    <Primitive.Portal>
      <Primitive.Content sideOffset={sideOffset} className={cx('z-50 rounded-[10px] border border-line bg-surface p-3 shadow-lg shadow-black/10', className)} {...props} />
    </Primitive.Portal>
  );
}
