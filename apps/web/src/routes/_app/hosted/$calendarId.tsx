/** One hosted calendar: tabs from `TABS`, each shown only at or above its access level. A `free-busy` grantee has no tab, only the name and owner. */
import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { isProblem, meQuery } from '../../../api.ts';
import { ToastProvider } from '../../../components/accounts/toast.tsx';
import { EventsTab } from '../../../components/hosted/events/events-tab.tsx';
import { atLeast, RESTORE_NOTE, useHostedCalendar, useRestoreCalendar, type Access, type CalendarTabProps, type HostedCalendar } from '../../../components/hosted/data.ts';
import { SettingsTab } from '../../../components/hosted/settings-tab.tsx';
import { PageHeader } from '../../../components/page-header.tsx';
import { Button } from '../../../components/ui/button.tsx';
import { Panel } from '../../../components/ui/panel.tsx';
import { ProblemAlert, toProblem } from '../../../components/ui/problem-alert.tsx';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../../components/ui/tabs.tsx';

/** The detail page's tabs, in order. To add one, add its row here and its panel to `PANELS`. */
const TABS = [
  { id: 'events', label: 'Events', min: 'read' },
  { id: 'settings', label: 'Settings', min: 'read' },
] as const satisfies readonly { id: string; label: string; min: Access }[];

const PANELS: Record<(typeof TABS)[number]['id'], (props: CalendarTabProps) => ReactNode> = { events: EventsTab, settings: SettingsTab };

export const Route = createFileRoute('/_app/hosted/$calendarId')({
  validateSearch: (search: Record<string, unknown>): { tab?: string } => (typeof search.tab === 'string' ? { tab: search.tab } : {}),
  component: () => (
    <ToastProvider>
      <CalendarDetail />
    </ToastProvider>
  ),
});

function CalendarDetail() {
  const { calendarId } = Route.useParams();
  const query = useHostedCalendar(calendarId);
  const me = useQuery(meQuery);

  if (query.error) {
    // A malformed id in the address (400) is a calendar that does not exist.
    if (isProblem(query.error) && [400, 403, 404].includes(query.error.status)) return <NoAccess />;
    return <ProblemAlert problem={toProblem(query.error)} className="max-w-2xl" />;
  }
  // Connected calendars are managed on Calendars, not here.
  if (query.data === null) return <NoAccess />;
  if (!query.data || !me.data) return null;
  return <Detail loaded={query.data} mine={query.data.calendar.owner.id === me.data.user.id} reload={() => query.refetch().then((result) => result.data)} />;
}

function NoAccess() {
  return (
    <Panel title="Calendar unavailable" className="max-w-3xl">
      <p className="text-sm text-ink-2">
        You don&rsquo;t have access to this calendar, or it doesn&rsquo;t exist.{' '}
        <Link to="/hosted" className="text-accent hover:underline">
          Back to Hosted
        </Link>
      </p>
    </Panel>
  );
}

function Detail({ loaded, mine, reload }: CalendarTabProps) {
  const { calendar } = loaded;
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const available = TABS.filter((tab) => atLeast(calendar.access, tab.min));
  const active = available.find((tab) => tab.id === search.tab) ?? available[0];

  return (
    <div className="max-w-3xl">
      <p className="mbe-1 text-sm">
        <Link to="/hosted" className="text-ink-2 hover:underline">
          Hosted
        </Link>
      </p>
      <PageHeader title={calendar.name} />
      {!mine && <p className="-mbs-3 mbe-5 text-sm text-ink-2">Owned by {calendar.owner.name}</p>}
      {calendar.state === 'gone' && <DeletedNotice calendar={calendar} mine={mine} />}
      {active && (
        <Tabs value={active.id} onValueChange={(tab) => void navigate({ search: { tab }, replace: true })}>
          <TabsList>
            {available.map((tab) => (
              <TabsTrigger key={tab.id} value={tab.id}>
                {tab.label}
              </TabsTrigger>
            ))}
          </TabsList>
          {available.map((tab) => {
            const TabPanel = PANELS[tab.id];
            return (
              <TabsContent key={tab.id} value={tab.id}>
                <TabPanel loaded={loaded} mine={mine} reload={reload} />
              </TabsContent>
            );
          })}
        </Tabs>
      )}
    </div>
  );
}

function DeletedNotice({ calendar, mine }: { calendar: HostedCalendar; mine: boolean }) {
  const { restore, isPending } = useRestoreCalendar();
  return (
    <div role="status" className="mbe-5 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-warning/30 bg-warning-soft px-3.5 py-2.5 text-sm text-warning">
      <p className="min-w-0 flex-1 basis-64">This calendar is deleted. {mine && RESTORE_NOTE}</p>
      {mine && (
        <Button size="sm" disabled={isPending} onClick={() => restore(calendar.id)}>
          Restore
        </Button>
      )}
    </div>
  );
}
