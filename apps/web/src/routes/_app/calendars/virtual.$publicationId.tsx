/** Edit a virtual calendar: its sources and priority, settings, or delete it. Saves with If-Match like the settings drawer. */
import type { Problem } from '@supercal/api-client';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { client, isProblem } from '../../../api.ts';
import { feedSearch, hidePassthroughs, useFeedCalendars, useFeeds, useRefreshFeeds } from '../../../components/calendars/data.ts';
import { diffSettings, settingsOf } from '../../../components/calendars/settings.ts';
import { CONFLICT_MESSAGE, usePublicationEditor } from '../../../components/calendars/use-publication-editor.ts';
import { VirtualBuilder, type VirtualDraft } from '../../../components/calendars/virtual-builder.tsx';
import { PageHeader } from '../../../components/page-header.tsx';
import { Button } from '../../../components/ui/button.tsx';
import { ProblemAlert, toProblem } from '../../../components/ui/problem-alert.tsx';

export const Route = createFileRoute('/_app/calendars/virtual/$publicationId')({ validateSearch: feedSearch, component: EditVirtualCalendar });

function EditVirtualCalendar() {
  const { publicationId } = Route.useParams();
  const search = Route.useSearch();
  const navigate = useNavigate();
  const { feed } = useFeeds(search.feed);
  const data = useFeedCalendars(feed);
  const refresh = useRefreshFeeds();
  const { query, save, conflict } = usePublicationEditor(publicationId);
  const [problem, setProblem] = useState<Problem | null>(null);
  const loaded = query.data;

  const back = () => navigate({ to: '/calendars', search: feed ? { feed: feed.id } : {} });

  async function submit({ settings, hideIndividuals }: VirtualDraft) {
    if (loaded?.publication.kind !== 'virtual') return;
    setProblem(null);
    try {
      const { patch } = diffSettings(settingsOf(loaded.publication), settings);
      if (Object.keys(patch).length > 0) await save.mutateAsync(patch);
      if (hideIndividuals) await hidePassthroughs(data.publications, settings.sources.map((s) => s.calendarId));
      await refresh();
      await back();
    } catch (error) {
      if (!(isProblem(error) && error.status === 412)) setProblem(toProblem(error));
    }
  }

  async function remove() {
    const { error } = await client.DELETE('/api/v1/publications/{id}', { params: { path: { id: publicationId } } });
    if (error) return setProblem(toProblem(error));
    await refresh();
    await back();
  }

  const publication = loaded?.publication;
  return (
    <>
      <PageHeader
        title={publication?.name ?? 'Virtual calendar'}
        actions={
          publication && (
            <Button variant="ghost" className="text-danger hover:text-danger" onClick={() => void remove()}>
              Delete virtual calendar
            </Button>
          )
        }
      />
      {query.error && <ProblemAlert problem={toProblem(query.error)} className="mb-5 max-w-2xl" />}
      {publication && publication.kind !== 'virtual' && <ProblemAlert problem={{ type: 'about:blank', status: 404, title: 'This is not a virtual calendar' }} />}
      {publication?.kind === 'virtual' && publication.status === 'disabled-invalid' && (
        <p role="alert" className="mb-5 max-w-2xl rounded-lg border border-warning/30 bg-warning-soft px-3.5 py-2.5 text-sm text-warning">
          Supercal turned this calendar off: {publication.statusDetail ?? 'its sources are no longer valid'}. Fix its sources and save to turn it back on.
        </p>
      )}
      {loaded && publication?.kind === 'virtual' && feed && !data.isPending && (
        <VirtualBuilder
          key={loaded.etag}
          groups={data.groups}
          initial={{ ...settingsOf(publication), sources: publication.sources }}
          onSubmit={(draft) => void submit(draft)}
          onCancel={() => void back()}
          pending={save.isPending}
          problem={problem}
          notice={conflict ? CONFLICT_MESSAGE : null}
        />
      )}
    </>
  );
}
