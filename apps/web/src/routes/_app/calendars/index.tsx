/** Calendars (product screen 4): every source calendar with its publish switch, settings drawer, virtual calendars and order. */
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { CalendarList } from '../../../components/calendars/calendar-list.tsx';
import { feedSearch, useFeedCalendars, useFeeds } from '../../../components/calendars/data.ts';
import { PrivacyKey, PublicationOrder, VirtualCalendars } from '../../../components/calendars/feed-panels.tsx';
import { FeedPicker } from '../../../components/calendars/feed-picker.tsx';
import { PublicationDrawer } from '../../../components/calendars/publication-drawer.tsx';
import { PageHeader } from '../../../components/page-header.tsx';
import { ProblemAlert, toProblem } from '../../../components/ui/problem-alert.tsx';

export const Route = createFileRoute('/_app/calendars/')({ validateSearch: feedSearch, component: Calendars });

function Calendars() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const { feeds, feed, error: feedsError } = useFeeds(search.feed);
  const data = useFeedCalendars(feed);
  const [editing, setEditing] = useState<{ id: string; fallbackColor: string | null } | null>(null);
  const error = feedsError ?? data.error;

  return (
    <>
      <PageHeader title="Calendars" />
      {feed && <FeedPicker feeds={feeds} value={feed} onChange={(id) => void navigate({ search: { feed: id } })} />}
      {error && <ProblemAlert problem={toProblem(error)} className="mb-5 max-w-2xl" />}
      {feed && !data.isPending && (
        <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_25rem]">
          <CalendarList
            feed={feed}
            groups={data.groups}
            onOpen={({ calendar, passthrough }) => passthrough && setEditing({ id: passthrough.id, fallbackColor: calendar.color })}
          />
          <div className="grid gap-6">
            <VirtualCalendars feed={feed} publications={data.publications} calendars={data.calendars} />
            <PublicationOrder feed={feed} publications={data.publications} colorOf={data.colorOf} />
            <PrivacyKey />
          </div>
        </div>
      )}
      {data.shared.length > 0 && <section className="mbs-6 grid gap-2" aria-label="Shared with you">
        <h2 className="text-lg font-semibold">Shared with you</h2>
        {data.shared.map((calendar) => <Link key={calendar.id} to="/hosted/$calendarId" params={{ calendarId: calendar.id }} className="text-accent underline focus-visible:outline active:opacity-70">{calendar.name} ({calendar.owner.name})</Link>)}
      </section>}
      {editing && <PublicationDrawer key={editing.id} publicationId={editing.id} fallbackColor={editing.fallbackColor} onClose={() => setEditing(null)} />}
    </>
  );
}
