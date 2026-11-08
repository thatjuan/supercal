/**
 * Subscribe (docs/product.md screen 7): get one feed into every calendar app. Secrets come from
 * memory (secrets.ts) after a rotation here or in Settings; otherwise each tab offers to rotate.
 * The Google tab also offers sinks (live updates), whose consent round trip returns here.
 */
import { useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { feedsQuery, subscribeQuery } from '../../../../components/feeds/queries.ts';
import { PageHeader } from '../../../../components/page-header.tsx';
import { LiveUpdates } from '../../../../components/subscribe/sink-card.tsx';
import { sinkSearch } from '../../../../components/subscribe/sinks.ts';
import { SubscribeTabs, tabForDevice } from '../../../../components/subscribe/subscribe-tabs.tsx';
import { useFeedSecrets } from '../../../../secrets.ts';

export const Route = createFileRoute('/_app/feeds/$feedId/subscribe')({
  validateSearch: sinkSearch,
  loader: ({ context, params }) =>
    Promise.all([context.queryClient.ensureQueryData(feedsQuery), context.queryClient.ensureQueryData(subscribeQuery(params.feedId))]),
  component: Subscribe,
});

function Subscribe() {
  const { feedId } = Route.useParams();
  const navigate = useNavigate();
  const search = Route.useSearch();
  const { data: feeds } = useSuspenseQuery(feedsQuery);
  const { data: info } = useSuspenseQuery(subscribeQuery(feedId));
  const secrets = useFeedSecrets(feedId);
  const feed = feeds.items.find((item) => item.id === feedId);

  return (
    <div className="max-w-3xl">
      <PageHeader title="Subscribe" />
      {feeds.items.length > 1 && (
        <label className="mb-5 grid max-w-xs gap-1.5">
          <span className="text-sm font-semibold">Feed</span>
          <select
            value={feedId}
            onChange={(event) => void navigate({ to: '/feeds/$feedId/subscribe', params: { feedId: event.target.value } })}
            className="h-10 rounded-[9px] border border-line-strong bg-surface px-3 text-[15px] shadow-xs"
          >
            {feeds.items.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <section aria-label={`Subscribe to ${feed?.name ?? 'feed'}`} className="rounded-[14px] border border-line bg-surface px-4 pt-2 pb-5 shadow-xs sm:px-5">
        <SubscribeTabs
          feedId={feedId}
          info={info}
          secrets={secrets}
          defaultTab={search.sinkPublication ? 'google' : tabForDevice(navigator.userAgent)}
          googleExtra={<LiveUpdates feedId={feedId} search={search} clearSearch={() => void navigate({ to: '/feeds/$feedId/subscribe', params: { feedId }, search: {}, replace: true })} />}
        />
      </section>
    </div>
  );
}

