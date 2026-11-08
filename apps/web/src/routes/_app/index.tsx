/** Overview: a placeholder until the onboarding and preview screens (#18–#20) fill it. */
import { useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { meQuery } from '../../api.ts';
import { PageHeader } from '../../components/page-header.tsx';

export const Route = createFileRoute('/_app/')({ component: Overview });

function Overview() {
  const { data: me } = useQuery(meQuery);
  return (
    <>
      <PageHeader title="Overview" />
      <section className="max-w-2xl rounded-[14px] border border-line bg-surface px-5 py-4 shadow-xs">
        <h2 className="text-[22px] font-semibold tracking-tight">Welcome{me ? `, ${me.user.name.split(' ')[0]}` : ''}</h2>
        <p className="mt-0.5 text-[15px] text-ink-2">
          Connect your calendar accounts, choose what to publish, and subscribe to one feed from any calendar app. Your accounts and calendars will show here.
        </p>
      </section>
    </>
  );
}
