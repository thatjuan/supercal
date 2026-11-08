/**
 * Tenant admin › Audit log (`GET /api/v1/audit-log`): newest first, filterable by target type,
 * loading the next page on the cursor as the list end scrolls into view. Each row expands to its data.
 */
import type { components } from '@supercal/api-client';
import { infiniteQueryOptions, useInfiniteQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { client } from '../../api.ts';
import { formatDateTime } from '../../lib/format.ts';
import { Button } from '../ui/button.tsx';
import { Panel } from '../ui/panel.tsx';
import { ProblemAlert, toProblem } from '../ui/problem-alert.tsx';

type AuditEntry = components['schemas']['AuditEntry'];

/** Target types the daemon audits (apps/daemon/src/api/kit/audit.ts). */
const TARGET_TYPES = ['account', 'api_key', 'feed', 'publication', 'tenant'] as const;
const PAGE_SIZE = 50;

/**
 * Pages of the log for `targetType` ('' for all). Not `$api.useInfiniteQuery`: it sends `cursor=0`
 * for the first page, which the opaque cursor rejects.
 */
const auditLogQuery = (targetType: string) =>
  infiniteQueryOptions({
    queryKey: ['get', '/api/v1/audit-log', { targetType }],
    queryFn: async ({ pageParam, signal }) => {
      const query = { limit: PAGE_SIZE, ...(targetType && { targetType }), ...(pageParam && { cursor: pageParam }) };
      const { data, error } = await client.GET('/api/v1/audit-log', { params: { query }, signal });
      if (error) throw error;
      return data;
    },
    initialPageParam: '',
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });

/** `names` maps user ids to display names (from the members list); unknown ids show as they are. */
export function AuditLog({ names }: { names: ReadonlyMap<string, string> }) {
  const [targetType, setTargetType] = useState('');
  const log = useInfiniteQuery(auditLogQuery(targetType));
  const end = useRef<HTMLDivElement>(null);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = log;

  useEffect(() => {
    const target = end.current;
    if (!target || !hasNextPage || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting) && !isFetchingNextPage) void fetchNextPage();
    });
    observer.observe(target);
    return () => observer.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const entries = log.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <Panel
      title="Audit log"
      description="Every change made through the API or the dashboard."
      actions={
        <select
          aria-label="Target type"
          value={targetType}
          onChange={(event) => setTargetType(event.target.value)}
          className="h-8 rounded-lg border border-line-strong bg-surface px-2 text-sm"
        >
          <option value="">All targets</option>
          {TARGET_TYPES.map((type) => (
            <option key={type} value={type}>
              {type}
            </option>
          ))}
        </select>
      }
    >
      {log.error && <ProblemAlert problem={toProblem(log.error)} />}
      {log.isSuccess && entries.length === 0 && <p className="text-sm text-ink-3">Nothing recorded yet.</p>}
      <ul aria-label="Audit entries" className="-my-1 divide-y divide-line">
        {entries.map((entry) => (
          <AuditRow key={entry.id} entry={entry} actor={names.get(entry.actor.userId) ?? entry.actor.userId} />
        ))}
      </ul>
      <div ref={end} className="mt-3 flex justify-center">
        {hasNextPage && (
          <Button size="sm" variant="ghost" disabled={isFetchingNextPage} onClick={() => void fetchNextPage()}>
            {isFetchingNextPage ? 'Loading…' : 'Load more'}
          </Button>
        )}
      </div>
    </Panel>
  );
}

function AuditRow({ entry, actor }: { entry: AuditEntry; actor: string }) {
  return (
    <li>
      <details className="group py-2.5">
        <summary className="grid cursor-pointer list-none grid-cols-[1fr_auto] gap-x-4 gap-y-0.5 sm:grid-cols-[10rem_1fr_auto]">
          <span className="truncate text-sm font-medium">{actor}</span>
          <span className="text-[13px] text-ink-3 sm:order-last">
            <time dateTime={entry.at}>{formatDateTime(entry.at)}</time>
          </span>
          <span className="col-span-2 min-w-0 truncate text-sm sm:col-span-1">
            <span className="font-mono text-[13px]">{entry.action}</span>{' '}
            <span className="text-ink-3">
              {entry.targetType}
              {entry.targetId && ` ${entry.targetId}`}
            </span>
          </span>
        </summary>
        <pre className="mt-2 overflow-x-auto rounded-lg bg-surface-2 p-3 font-mono text-xs text-ink-2">
          {JSON.stringify({ actor: entry.actor, target: { type: entry.targetType, id: entry.targetId }, data: entry.data }, null, 2)}
        </pre>
      </details>
    </li>
  );
}
