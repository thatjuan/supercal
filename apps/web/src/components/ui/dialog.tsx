/** Modal dialogs (Radix). Compose `Dialog` › `DialogTrigger` + `DialogContent` (which takes a required title). */
import { Dialog as Primitive } from 'radix-ui';
import type { ComponentProps, ReactNode } from 'react';
import { cx } from './cx.ts';

export const Dialog = Primitive.Root;
export const DialogTrigger = Primitive.Trigger;
export const DialogClose = Primitive.Close;

type DialogContentProps = ComponentProps<typeof Primitive.Content> & { title: string; description?: ReactNode };

export function DialogContent({ title, description, className, children, ...props }: DialogContentProps) {
  return (
    <Primitive.Portal>
      <Primitive.Overlay className="fixed inset-0 z-40 bg-black/30" />
      <Primitive.Content
        className={cx(
          'fixed top-1/2 left-1/2 z-50 w-[min(28rem,calc(100vw-2rem))] -translate-1/2 rounded-[14px] border border-line bg-surface p-5 shadow-xl',
          className,
        )}
        {...props}
      >
        <Primitive.Title className="text-lg font-semibold tracking-tight">{title}</Primitive.Title>
        {description ? (
          <Primitive.Description className="mt-0.5 text-sm text-ink-2">{description}</Primitive.Description>
        ) : (
          <Primitive.Description className="sr-only">{title}</Primitive.Description>
        )}
        <div className="mt-4">{children}</div>
      </Primitive.Content>
    </Primitive.Portal>
  );
}
