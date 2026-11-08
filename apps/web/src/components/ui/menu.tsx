/** Dropdown menus (Radix). `Menu` is the root and `MenuTrigger` wraps its trigger with `asChild`. */
import { DropdownMenu } from 'radix-ui';
import type { ComponentProps } from 'react';
import { cx } from './cx.ts';
import { Icon } from './icon.tsx';

export const Menu = DropdownMenu.Root;
export const MenuTrigger = DropdownMenu.Trigger;
export const MenuGroup = DropdownMenu.Group;

export function MenuContent({ className, sideOffset = 4, ...props }: ComponentProps<typeof DropdownMenu.Content>) {
  return (
    <DropdownMenu.Portal>
      <DropdownMenu.Content
        sideOffset={sideOffset}
        className={cx('z-50 min-w-48 rounded-[10px] border border-line bg-surface p-1 text-sm text-ink shadow-lg shadow-black/10', className)}
        {...props}
      />
    </DropdownMenu.Portal>
  );
}

const itemClass = 'flex h-8 cursor-default items-center gap-2 rounded-md px-2.5 outline-none select-none data-highlighted:bg-surface-2 data-disabled:opacity-50';

export function MenuItem({ className, ...props }: ComponentProps<typeof DropdownMenu.Item>) {
  return <DropdownMenu.Item className={cx(itemClass, className)} {...props} />;
}

/** A single-choice group (such as the tenant list or the theme): `MenuRadioItem`s show a check when selected. */
export const MenuRadioGroup = DropdownMenu.RadioGroup;

export function MenuRadioItem({ className, children, ...props }: ComponentProps<typeof DropdownMenu.RadioItem>) {
  return (
    <DropdownMenu.RadioItem className={cx(itemClass, 'pr-7', className)} {...props}>
      {children}
      <DropdownMenu.ItemIndicator className="ml-auto -mr-5 text-accent">
        <Icon name="check" className="size-4" />
      </DropdownMenu.ItemIndicator>
    </DropdownMenu.RadioItem>
  );
}

export function MenuLabel({ className, ...props }: ComponentProps<typeof DropdownMenu.Label>) {
  return <DropdownMenu.Label className={cx('px-2.5 pt-1.5 pb-1 text-[11px] font-medium tracking-wide text-ink-3 uppercase', className)} {...props} />;
}

export function MenuSeparator({ className, ...props }: ComponentProps<typeof DropdownMenu.Separator>) {
  return <DropdownMenu.Separator className={cx('my-1 h-px bg-line', className)} {...props} />;
}
