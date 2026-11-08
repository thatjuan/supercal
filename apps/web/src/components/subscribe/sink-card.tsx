/**
 * "Live updates in Google Calendar" on the Subscribe page's Google tab: per publication, the sinks
 * mirroring it with their status, "Mirror to Google account ▾", remove and (when the calendar was
 * deleted in Google) recreate. `LiveUpdates` wires the queries and the consent round trip;
 * `SinkCard` only renders.
 */
import type { Problem } from '@supercal/api-client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { $api, meQuery } from '../../api.ts';
import { accountsQuery, instanceQuery } from '../accounts/data.ts';
import type { Account } from '../accounts/health.ts';
import { Badge } from '../ui/badge.tsx';
import { Button } from '../ui/button.tsx';
import { ConfirmDialog } from '../ui/confirm-dialog.tsx';
import { Icon } from '../ui/icon.tsx';
import { Menu, MenuContent, MenuItem, MenuLabel, MenuTrigger } from '../ui/menu.tsx';
import { Panel } from '../ui/panel.tsx';
import { ProblemAlert, toProblem } from '../ui/problem-alert.tsx';
import { consentReturn, consentReturnTo, consentUrl, sinksQuery, type Sink, type SinkSearch } from './sinks.ts';

const STATUS = {
  syncing: { tone: 'info', label: 'Syncing' },
  up_to_date: { tone: 'accent', label: 'Up to date' },
  error: { tone: 'danger', label: 'Error' },
  calendar_missing: { tone: 'warning', label: 'Calendar missing' },
} as const satisfies Record<Sink['status'], { tone: string; label: string }>;

type CardProps = {
  publications: { id: string; name: string }[];
  /** The user's own Google accounts. */
  accounts: Pick<Account, 'id' | 'displayName' | 'email'>[];
  sinks: Sink[];
  busy: boolean;
  problem: Problem | null;
  onMirror: (publicationId: string, accountId: string) => void;
  onRemove: (sink: Sink) => void;
  onRecreate: (sink: Sink) => void;
};

export function SinkCard({ publications, accounts, sinks, busy, problem, onMirror, onRemove, onRecreate }: CardProps) {
  const accountName = (id: string) => {
    const account = accounts.find((a) => a.id === id);
    return account?.email ?? account?.displayName ?? 'Google account';
  };
  return (
    <Panel
      title="Live updates in Google Calendar"
      description="Supercal creates a calendar in your Google account and keeps it up to date within seconds. Edits made to that calendar in Google are overwritten."
    >
      {problem && <ProblemAlert problem={problem} className="mb-3" />}
      {accounts.length === 0 ? (
        <p className="text-sm text-ink-2">Connect a Google account on the Accounts page to mirror a calendar into it.</p>
      ) : (
        <ul className="grid divide-y divide-line">
          {publications.map((pub) => {
            const own = sinks.filter((s) => s.publicationId === pub.id);
            const free = accounts.filter((a) => !own.some((s) => s.accountId === a.id));
            return (
              <li key={pub.id} className="grid gap-2 py-3 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">{pub.name}</span>
                  {free.length > 0 && (
                    <Menu>
                      <MenuTrigger asChild>
                        <Button size="sm" disabled={busy}>
                          Mirror to Google account
                          <Icon name="chevron" className="size-3.5 rotate-90" />
                        </Button>
                      </MenuTrigger>
                      <MenuContent align="end">
                        <MenuLabel>Mirror “{pub.name}” to</MenuLabel>
                        {free.map((account) => (
                          <MenuItem key={account.id} onSelect={() => onMirror(pub.id, account.id)}>
                            {account.email ?? account.displayName}
                          </MenuItem>
                        ))}
                      </MenuContent>
                    </Menu>
                  )}
                </div>
                {own.map((s) => (
                  <div key={s.id} className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="text-ink-2">{accountName(s.accountId)}</span>
                    <Badge tone={STATUS[s.status].tone}>{STATUS[s.status].label}</Badge>
                    {s.status === 'error' && s.error && <span className="text-danger">{s.error}</span>}
                    {s.status === 'calendar_missing' && <span className="text-ink-2">The calendar was deleted in Google.</span>}
                    <span className="ml-auto flex gap-1.5">
                      {s.status === 'calendar_missing' && (
                        <Button size="sm" disabled={busy} onClick={() => onRecreate(s)}>
                          Recreate
                        </Button>
                      )}
                      <Button size="sm" variant="ghost" disabled={busy} onClick={() => onRemove(s)}>
                        Remove
                      </Button>
                    </span>
                  </div>
                ))}
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

/**
 * The card with its data, shown when Google is configured. `search` is the page's consent return
 * (see `sinks.ts`); `clearSearch` drops it from the address once handled.
 */
export function LiveUpdates({ feedId, search, clearSearch }: { feedId: string; search: SinkSearch; clearSearch: () => void }) {
  const client = useQueryClient();
  const instance = useQuery(instanceQuery);
  const me = useQuery(meQuery);
  const accounts = useQuery(accountsQuery);
  const publications = $api.useQuery('get', '/api/v1/feeds/{id}/publications', { params: { path: { id: feedId } } });
  const sinks = useQuery({ ...sinksQuery, refetchInterval: (query) => (query.state.data?.items.some((s) => s.status === 'syncing') ? 3000 : false) });
  const [problem, setProblem] = useState<Problem | null>(null);
  const [removing, setRemoving] = useState<Sink | null>(null);
  const [deleteCalendar, setDeleteCalendar] = useState(true);
  const handled = useRef<string | null>(null);

  const refresh = () => client.invalidateQueries({ queryKey: sinksQuery.queryKey });
  const create = $api.useMutation('post', '/api/v1/sinks', {
    onSuccess: refresh,
    onError: (error) => {
      const url = consentUrl(error);
      if (url) window.location.assign(url);
      else setProblem(toProblem(error));
    },
  });
  const remove = $api.useMutation('delete', '/api/v1/sinks/{id}', { onSuccess: refresh });
  const mirror = (publicationId: string, accountId: string) => {
    setProblem(null);
    create.mutate({ body: { publicationId, accountId, returnTo: consentReturnTo(feedId, publicationId, accountId) } });
  };
  const drop = (sink: Sink, alsoCalendar: boolean) => remove.mutateAsync({ params: { path: { id: sink.id }, query: { deleteCalendar: alsoCalendar ? 'true' : 'false' } } });

  useEffect(() => {
    const back = consentReturn(search);
    const key = JSON.stringify(search);
    if (!back || handled.current === key) return;
    handled.current = key;
    if ('error' in back) setProblem({ type: 'about:blank', title: 'Not mirrored', status: 409, detail: back.error });
    else mirror(back.create.publicationId, back.create.accountId);
    clearSearch();
  });

  if (!instance.data?.providers.google) return null;
  const google = (accounts.data?.items ?? []).filter((a) => a.provider === 'google' && a.ownerUserId === me.data?.user.id);
  const feedSinks = (sinks.data?.items ?? []).filter((s) => publications.data?.items.some((p) => p.id === s.publicationId));

  return (
    <>
      <SinkCard
        publications={publications.data?.items ?? []}
        accounts={google}
        sinks={feedSinks}
        busy={create.isPending || remove.isPending}
        problem={problem}
        onMirror={mirror}
        onRemove={(sink) => {
          setDeleteCalendar(true);
          setRemoving(sink);
        }}
        onRecreate={(sink) => void drop(sink, false).then(() => mirror(sink.publicationId, sink.accountId), (error: unknown) => setProblem(toProblem(error)))}
      />
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title="Stop mirroring?"
        description={
          <label className="mt-2 flex items-center gap-2">
            <input type="checkbox" checked={deleteCalendar} onChange={(event) => setDeleteCalendar(event.target.checked)} />
            Also delete the calendar from Google
          </label>
        }
        confirmLabel="Remove"
        danger
        error={remove.error ? toProblem(remove.error) : null}
        onConfirm={() => (removing ? drop(removing, deleteCalendar) : Promise.resolve())}
      />
    </>
  );
}
