/** `/feeds`: the sidebar's Subscribe entry. Opens the Subscribe screen of the user's default feed. */
import { createFileRoute, redirect } from '@tanstack/react-router';
import { feedsQuery } from '../../../components/feeds/queries.ts';

export const Route = createFileRoute('/_app/feeds/')({
  beforeLoad: async ({ context }) => {
    const { items } = await context.queryClient.ensureQueryData(feedsQuery);
    const feed = items.find((item) => item.isDefault) ?? items[0];
    if (feed) throw redirect({ to: '/feeds/$feedId/subscribe', params: { feedId: feed.id }, replace: true });
  },
  component: () => <p className="text-ink-2">You have no feeds yet.</p>,
});
