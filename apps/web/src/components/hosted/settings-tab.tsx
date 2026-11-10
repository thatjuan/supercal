/** A hosted calendar's Settings tab: details, import and export, where to publish it, and deleting it. */
import type { Problem } from '@supercal/api-client';
import { Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { $api } from '../../api.ts';
import { useRefreshFeeds } from '../calendars/data.ts';
import { Button } from '../ui/button.tsx';
import { ConfirmDialog } from '../ui/confirm-dialog.tsx';
import { Panel } from '../ui/panel.tsx';
import { toProblem } from '../ui/problem-alert.tsx';
import { atLeast, RESTORE_NOTE, type CalendarTabProps, type Calendar } from './data.ts';
import { DetailsForm } from './details-form.tsx';
import { ImportExport } from './import-export.tsx';

export function SettingsTab({ loaded, mine, reload }: CalendarTabProps) {
  const { calendar } = loaded;
  return (
    <div className="grid gap-5">
      <DetailsForm loaded={loaded} reload={reload} />
      <ImportExport calendar={calendar} />
      <Panel title="Publishing">
        <p className="text-sm text-ink-2">
          Hosted calendars start unpublished, and their owner publishes them per feed on{' '}
          <Link to="/calendars" className="text-accent hover:underline">
            Calendars
          </Link>
          .
        </p>
      </Panel>
      {/* Tenant admins may delete other people's calendars through the API, but this screen does not offer it. */}
      {atLeast(calendar.access, 'owner') && mine && calendar.state === 'active' && <DangerZone calendar={calendar} />}
    </div>
  );
}

function DangerZone({ calendar }: { calendar: Calendar }) {
  const navigate = useNavigate();
  const refresh = useRefreshFeeds();
  const remove = $api.useMutation('delete', '/api/v1/calendars/{id}');
  const [confirming, setConfirming] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);

  async function deleteCalendar() {
    setProblem(null);
    try {
      await remove.mutateAsync({ params: { path: { id: calendar.id } } });
    } catch (failure) {
      setProblem(toProblem(failure));
      throw failure;
    }
    await refresh();
    await navigate({ to: '/hosted' });
  }

  return (
    <Panel title="Danger zone">
      <Button variant="danger" onClick={() => setConfirming(true)}>
        Delete calendar
      </Button>
      <ConfirmDialog
        open={confirming}
        onOpenChange={(open) => {
          setConfirming(open);
          if (!open) setProblem(null);
        }}
        title={`Delete “${calendar.name}”?`}
        description={`You can restore the calendar and its events for 30 days. Its feed publications are turned off and it is removed from virtual calendars. ${RESTORE_NOTE}`}
        confirmLabel="Delete calendar"
        danger
        onConfirm={deleteCalendar}
        error={problem}
      />
    </Panel>
  );
}
