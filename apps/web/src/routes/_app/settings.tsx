/** Settings (docs/product.md screen 8): profile, feeds and their credentials, API keys, theme. */
import { useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { $api, meQuery } from '../../api.ts';
import { feedsQuery } from '../../components/feeds/queries.ts';
import { PageHeader } from '../../components/page-header.tsx';
import { ApiKeySettings } from '../../components/settings/api-keys.tsx';
import { FeedSettings } from '../../components/settings/feeds.tsx';
import { ProfileSettings } from '../../components/settings/profile.tsx';
import { ThemeSettings } from '../../components/settings/theme.tsx';

export const Route = createFileRoute('/_app/settings')({
  loader: ({ context }) =>
    Promise.all([context.queryClient.ensureQueryData(feedsQuery), context.queryClient.ensureQueryData($api.queryOptions('get', '/api/v1/api-keys'))]),
  component: Settings,
});

function Settings() {
  const { data: me } = useSuspenseQuery(meQuery);
  return (
    <div className="max-w-3xl">
      <PageHeader title="Settings" />
      <div className="grid gap-5">
        <ProfileSettings user={me.user} />
        <FeedSettings />
        <ApiKeySettings />
        <ThemeSettings />
      </div>
    </div>
  );
}
