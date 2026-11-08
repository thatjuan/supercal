/** New virtual calendar (product screen 5): merges two or more source calendars into one publication. */
import type { Problem } from '@supercal/api-client';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { $api } from '../../../api.ts';
import { feedSearch, hidePassthroughs, useFeedCalendars, useFeeds, useRefreshFeeds } from '../../../components/calendars/data.ts';
import { VirtualBuilder, type VirtualDraft } from '../../../components/calendars/virtual-builder.tsx';
import { PageHeader } from '../../../components/page-header.tsx';
import { toProblem } from '../../../components/ui/problem-alert.tsx';

export const Route = createFileRoute('/_app/calendars/virtual/new')({ validateSearch: feedSearch, component: NewVirtualCalendar });

function NewVirtualCalendar() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  const { feed } = useFeeds(search.feed);
  const data = useFeedCalendars(feed);
  const refresh = useRefreshFeeds();
  const create = $api.useMutation('post', '/api/v1/feeds/{id}/publications');
  const [problem, setProblem] = useState<Problem | null>(null);

  const back = () => navigate({ to: '/calendars', search: feed ? { feed: feed.id } : {} });

  async function save({ settings, hideIndividuals }: VirtualDraft) {
    if (!feed) return;
    setProblem(null);
    try {
      await create.mutateAsync({ params: { path: { id: feed.id } }, body: { kind: 'virtual', ...settings } });
      if (hideIndividuals) await hidePassthroughs(data.publications, settings.sources.map((s) => s.calendarId));
      await refresh();
      await back();
    } catch (error) {
      setProblem(toProblem(error));
    }
  }

  return (
    <>
      <PageHeader title="New virtual calendar" />
      {feed && !data.isPending && <VirtualBuilder groups={data.groups} onSubmit={(draft) => void save(draft)} onCancel={() => void back()} pending={create.isPending} problem={problem} />}
    </>
  );
}
