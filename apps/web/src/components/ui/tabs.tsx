/** Tabs (Radix). The list scrolls sideways on narrow screens instead of wrapping. */
import { Tabs as Primitive } from 'radix-ui';
import type { ComponentProps } from 'react';
import { cx } from './cx.ts';

export const Tabs = Primitive.Root;

export function TabsList({ className, ...props }: ComponentProps<typeof Primitive.List>) {
  return <Primitive.List className={cx('-mx-1 flex gap-1 overflow-x-auto overflow-y-hidden border-b border-line px-1 [scrollbar-width:none]', className)} {...props} />;
}

export function TabsTrigger({ className, ...props }: ComponentProps<typeof Primitive.Trigger>) {
  return (
    <Primitive.Trigger
      className={cx(
        '-mb-px h-10 shrink-0 border-b-2 border-transparent px-3 text-[15px] whitespace-nowrap text-ink-2 hover:text-ink',
        'data-[state=active]:border-accent data-[state=active]:font-semibold data-[state=active]:text-ink',
        className,
      )}
      {...props}
    />
  );
}

export function TabsContent({ className, ...props }: ComponentProps<typeof Primitive.Content>) {
  return <Primitive.Content className={cx('pt-5 focus-visible:outline-none', className)} {...props} />;
}
