/** The per-account dialogs on the Accounts screen: Rename (optimistic) and Remove (with what it takes down). */
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { $api } from '../../api.ts';
import { Button } from '../ui/button.tsx';
import { Dialog, DialogClose, DialogContent } from '../ui/dialog.tsx';
import { Field } from '../ui/field.tsx';
import { ProblemAlert, toProblem } from '../ui/problem-alert.tsx';
import { refreshAccounts } from './data.ts';
import type { Account, Calendar } from './health.ts';

type DialogProps = { account: Account; open: boolean; onOpenChange: (open: boolean) => void };

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

/** "Removes 3 calendars from 2 publications": every calendar of the account and each publication it feeds. */
export function removalSummary(calendars: readonly Calendar[]): string {
  const publications = new Set(calendars.flatMap((calendar) => calendar.publicationIds));
  return `Removes ${plural(calendars.length, 'calendar')} from ${plural(publications.size, 'publication')}.`;
}

export function RemoveDialog({ account, calendars, open, onOpenChange, onRemoved }: DialogProps & { calendars: readonly Calendar[]; onRemoved: () => void }) {
  const client = useQueryClient();
  const remove = $api.useMutation('delete', '/api/v1/accounts/{id}', {
    onSuccess: async () => {
      onOpenChange(false);
      onRemoved();
      await refreshAccounts(client);
    },
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={`Remove ${account.displayName}?`} description={removalSummary(calendars)}>
        <p className="text-sm text-ink-2">Their events stop publishing at once. The calendars stay untouched at the provider, and you can connect the account again later.</p>
        {remove.error && <ProblemAlert problem={toProblem(remove.error)} className="mt-3" />}
        <div className="mt-5 flex justify-end gap-2">
          <DialogClose asChild>
            <Button>Cancel</Button>
          </DialogClose>
          <Button variant="danger" disabled={remove.isPending} onClick={() => remove.mutate({ params: { path: { id: account.id } } })}>
            {remove.isPending ? 'Removing…' : 'Remove account'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Renames through `onRename`, which applies the change optimistically, so the dialog closes at once. Mount it when opening, so it starts from the current name. */
export function RenameDialog({ account, open, onOpenChange, onRename }: DialogProps & { onRename: (displayName: string) => void }) {
  const [name, setName] = useState(account.displayName);
  const error = name.trim() ? (name.trim().length > 100 ? 'Use at most 100 characters' : undefined) : 'Enter a name';
  const [submitted, setSubmitted] = useState(false);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Rename account">
        <form
          noValidate
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            setSubmitted(true);
            if (error) return;
            if (name.trim() !== account.displayName) onRename(name.trim());
            onOpenChange(false);
          }}
        >
          <Field label="Name" value={name} onChange={(event) => setName(event.target.value)} error={submitted ? error : undefined} />
          <div className="flex justify-end gap-2">
            <DialogClose asChild>
              <Button>Cancel</Button>
            </DialogClose>
            <Button type="submit" variant="primary">
              Save
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
