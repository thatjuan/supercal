/** The New calendar dialog: creates a hosted calendar and goes to it. The form lives inside the dialog's content, so closing it resets the fields. */
import type { Problem } from '@supercal/api-client';
import { useNavigate } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { $api } from '../../api.ts';
import { browserZone } from '../../lib/zones.ts';
import { useRefreshFeeds } from '../calendars/data.ts';
import { PALETTE } from '../calendars/settings-fields.tsx';
import { Button } from '../ui/button.tsx';
import { Dialog, DialogContent } from '../ui/dialog.tsx';
import { fieldErrors, ProblemAlert, toProblem } from '../ui/problem-alert.tsx';
import { CalendarFields, NAME_MISSING, type CalendarValues } from './calendar-fields.tsx';

export function NewCalendarDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="New calendar" description="Its events live in Supercal, with no provider behind it.">
        <NewCalendarForm />
      </DialogContent>
    </Dialog>
  );
}

function NewCalendarForm() {
  const navigate = useNavigate();
  const refresh = useRefreshFeeds();
  const create = $api.useMutation('post', '/api/v1/calendars');
  const [values, setValues] = useState<CalendarValues>({ name: '', color: PALETTE[0], timezone: browserZone, description: '' });
  const [tried, setTried] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const name = values.name.trim();

  async function submit(event: FormEvent) {
    event.preventDefault();
    setTried(true);
    if (name === '') return;
    setProblem(null);
    try {
      const created = await create.mutateAsync({
        body: {
          name,
          ...(values.color && { color: values.color.toLowerCase() }),
          ...(values.timezone && { timezone: values.timezone }),
          ...(values.description && { description: values.description }),
        },
      });
      await refresh();
      await navigate({ to: '/hosted/$calendarId', params: { calendarId: created.id } });
    } catch (failure) {
      setProblem(toProblem(failure));
    }
  }

  const errors = fieldErrors(problem);
  return (
    <form noValidate onSubmit={(event) => void submit(event)} className="grid gap-4">
      {problem && <ProblemAlert problem={problem} />}
      <CalendarFields values={values} onChange={setValues} nameError={tried && name === '' ? NAME_MISSING : errors.name} descriptionError={errors.description} />
      <div className="flex justify-end">
        <Button type="submit" variant="primary" disabled={create.isPending}>
          {create.isPending ? 'Creating…' : 'Create calendar'}
        </Button>
      </div>
    </form>
  );
}
