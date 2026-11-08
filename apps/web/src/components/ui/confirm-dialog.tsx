/** A modal that asks before a destructive or irreversible action, such as a rotation or a delete. */
import type { Problem } from '@supercal/api-client';
import { useState, type ReactNode } from 'react';
import { Button } from './button.tsx';
import { Dialog, DialogClose, DialogContent } from './dialog.tsx';
import { ProblemAlert } from './problem-alert.tsx';

type ConfirmDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  /** Runs on confirm; the dialog closes when it resolves and stays open (for the caller's error) when it throws. */
  onConfirm: () => Promise<unknown>;
  danger?: boolean;
  /** The last failure of `onConfirm`, shown above the buttons. */
  error?: Problem | null;
};

export function ConfirmDialog({ open, onOpenChange, title, description, confirmLabel, onConfirm, danger = false, error }: ConfirmDialogProps) {
  const [pending, setPending] = useState(false);

  async function confirm() {
    setPending(true);
    try {
      await onConfirm();
      onOpenChange(false);
    } catch {
      // The caller shows the error; keep the dialog so the user can retry or cancel.
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={title} description={description}>
        {error && <ProblemAlert problem={error} className="mb-3" />}
        <div className="flex justify-end gap-2">
          <DialogClose asChild>
            <Button>Cancel</Button>
          </DialogClose>
          <Button variant={danger ? 'danger' : 'primary'} disabled={pending} onClick={() => void confirm()}>
            {pending ? 'Working…' : confirmLabel}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
