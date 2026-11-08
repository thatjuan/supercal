/** An on/off switch (Radix), such as a calendar's publish toggle. */
import { Switch as Primitive } from 'radix-ui';
import type { ComponentProps } from 'react';
import { cx } from './cx.ts';

export function Switch({ className, ...props }: ComponentProps<typeof Primitive.Root>) {
  return (
    <Primitive.Root
      className={cx('inline-flex h-6 w-11 shrink-0 items-center rounded-full bg-line-strong p-[3px] transition-colors data-[state=checked]:bg-accent', className)}
      {...props}
    >
      <Primitive.Thumb className="size-[18px] rounded-full bg-white shadow-sm transition-transform data-[state=checked]:translate-x-5" />
    </Primitive.Root>
  );
}
