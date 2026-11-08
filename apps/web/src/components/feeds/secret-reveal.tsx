/** The one-time reveal of secrets the server shows once: feed credentials after creation or rotation, a new API key. */
import type { ReactNode } from 'react';
import { Button } from '../ui/button.tsx';
import { CopyField } from '../ui/copy.tsx';
import { Dialog, DialogClose, DialogContent } from '../ui/dialog.tsx';

export type Secret = { label: string; value: string };

type SecretRevealProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  secrets: readonly Secret[];
  /** What happens to whatever used the old secret, if it replaced one. */
  warning?: ReactNode;
  children?: ReactNode;
};

export function SecretReveal({ open, onOpenChange, title, secrets, warning, children }: SecretRevealProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={title} description="Copy it now: Supercal shows it only once." className="w-[min(34rem,calc(100vw-2rem))]">
        <div className="grid gap-3">
          {warning && <p className="rounded-lg bg-warning-soft px-3.5 py-2.5 text-sm text-warning">{warning}</p>}
          {secrets.map((secret) => (
            <CopyField key={secret.label} label={secret.label} value={secret.value} />
          ))}
          {children}
          <div className="flex justify-end">
            <DialogClose asChild>
              <Button variant="primary">Done</Button>
            </DialogClose>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
