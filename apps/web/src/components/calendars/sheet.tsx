/** A right-hand drawer (Radix Dialog), such as publication settings. Controlled through `open`. */
import { Dialog } from 'radix-ui';
import type { ReactNode } from 'react';
import { Icon } from '../ui/icon.tsx';

export function Sheet({ open, onOpenChange, title, description, children }: { open: boolean; onOpenChange: (open: boolean) => void; title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/25" />
        <Dialog.Content className="fixed inset-y-0 right-0 z-50 flex w-[min(30rem,100vw)] flex-col border-l border-line bg-surface shadow-xl outline-none">
          <header className="flex items-start gap-3 border-b border-line px-5 pt-5 pb-4">
            <div className="min-w-0 flex-1">
              <Dialog.Title className="truncate text-lg font-semibold tracking-tight">{title}</Dialog.Title>
              <Dialog.Description className={description ? 'mt-0.5 text-sm text-ink-2' : 'sr-only'}>{description ?? title}</Dialog.Description>
            </div>
            <Dialog.Close className="-mr-1 rounded-md p-1 text-ink-2 hover:bg-surface-2 hover:text-ink" aria-label="Close">
              <Icon name="close" className="size-5" />
            </Dialog.Close>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
