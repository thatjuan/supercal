/**
 * A calendar's Sharing tab: who has access, at what level, and granting more. Only owners and
 * tenant admins may grant or remove `manage`, so a manager sees those rows read-only and is never
 * offered the level. The server still enforces this (`requireGrantChange`); a refusal shows as a 403.
 */
import type { components, Problem } from '@supercal/api-client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { $api, isProblem, meQuery } from '../../api.ts';
import { PROVIDER } from '../calendars/data.ts';
import { organizationQuery } from '../admin/members.tsx';
import { Badge } from '../ui/badge.tsx';
import { Button } from '../ui/button.tsx';
import { ConfirmDialog } from '../ui/confirm-dialog.tsx';
import { Panel } from '../ui/panel.tsx';
import { ProblemAlert, toProblem } from '../ui/problem-alert.tsx';
import { atLeast, type CalendarTabProps, type Calendar } from './data.ts';

type Share = components['schemas']['CalendarShare'];
type ShareAccess = Share['access'];
type Tenant = components['schemas']['Tenant'];

const LEVELS = [
  { value: 'free-busy', label: 'Free/busy only', explanation: 'Can see when the calendar is busy, nothing else.' },
  { value: 'read', label: 'See events', explanation: 'Can see events; private events show as “Busy”.' },
  { value: 'write', label: 'Edit events', explanation: 'Can see all events, including private ones, and change them.' },
  { value: 'manage', label: 'Manage', explanation: 'Can also rename the calendar and manage sharing and links.' },
] as const satisfies readonly { value: ShareAccess; label: string; explanation: string }[];

type Level = (typeof LEVELS)[number];

const levelOf = (access: ShareAccess): Level => LEVELS.find((level) => level.value === access) ?? LEVELS[0];
const isShareAccess = (value: string): value is ShareAccess => LEVELS.some((level) => level.value === value);

const SHARES = '/api/v1/calendars/{id}/shares';
const SHARE = '/api/v1/calendars/{id}/shares/{shareId}';

/** Better Auth's default cap on the members `getFullOrganization` returns; it reports no total. */
const MEMBER_CAP = 100;
/** The picker's value for the tenant-wide grant; every other value is a user id. */
const EVERYONE = 'everyone';

export function SharingTab({ loaded: { calendar } }: CalendarTabProps) {
  const queryClient = useQueryClient();
  const me = useQuery(meQuery);
  const sharesQuery = $api.queryOptions('get', SHARES, { params: { path: { id: calendar.id } } });
  const shares = useQuery(sharesQuery);
  const refresh = () => queryClient.invalidateQueries({ queryKey: sharesQuery.queryKey });

  const accounts = $api.useQuery('get', '/api/v1/accounts', {}, { enabled: calendar.kind === 'connected' });
  const account = accounts.data?.items.find((account) => account.id === calendar.accountId);
  const mayGrantManage = calendar.kind === 'hosted' && atLeast(calendar.access, 'owner');
  const levels = LEVELS.filter((level) => (level.value !== 'manage' || mayGrantManage) && (level.value !== 'write' || calendar.writable));
  const tenant = me.data?.tenant;
  const items = shares.data?.items ?? [];

  return (
    <div className="grid gap-5">
      {calendar.kind === 'connected' && !calendar.writable && <p className="text-sm text-ink-2">Existing editing grants act as read access until the provider allows editing again.</p>}
      {calendar.kind === 'connected' && calendar.writable && <p className="text-sm text-ink-2">Edits are made in the owner's {account ? PROVIDER[account.provider] : 'provider'} account.</p>}
      <Panel title="Sharing" description="Grant colleagues in this tenant access to this calendar.">
        <div className="grid gap-5">
          {tenant && <AddShare calendar={calendar} tenant={tenant} shares={items} levels={levels} onChanged={refresh} />}
          {shares.error && <ProblemAlert problem={toProblem(shares.error)} />}
          {shares.data &&
            (items.length === 0 ? (
              <p className="text-sm text-ink-3">Not shared with anyone yet.</p>
            ) : (
              <ul aria-label="People with access" className="divide-y divide-line border-y border-line">
                {items.map((share) => (
                  <ShareRow key={share.id} share={share} calendarId={calendar.id} tenantName={tenant?.name ?? 'this tenant'} levels={levels} readOnly={share.access === 'manage' && !mayGrantManage} onChanged={refresh} />
                ))}
              </ul>
            ))}
          <p className="text-[13px] text-ink-3">If someone has both a personal grant and an Everyone grant, the higher one applies.</p>
        </div>
      </Panel>
      <Panel title="Access levels">
        <dl className="grid gap-x-4 gap-y-3 text-sm sm:grid-cols-[8rem_minmax(0,1fr)] sm:gap-y-2">
          {levels.map((level) => (
            <div key={level.value} className="grid gap-0.5 sm:col-span-2 sm:grid-cols-subgrid">
              <dt className="font-semibold">{level.label}</dt>
              <dd className="text-ink-2">{level.explanation}</dd>
            </div>
          ))}
        </dl>
      </Panel>
    </div>
  );
}

/** Who may still get a grant: Everyone unless a tenant-wide grant exists, then members other than the owner and existing personal grantees. */
function pickerOptions(members: readonly { user: { id: string; name: string; email: string } }[], shares: readonly Share[], ownerId: string, tenantName: string) {
  const granted = new Set(shares.flatMap((share) => (share.grantee.type === 'user' ? [share.grantee.userId] : [])));
  const hasEveryone = shares.some((share) => share.grantee.type === 'tenant');
  return [
    ...(hasEveryone ? [] : [{ value: EVERYONE, label: `Everyone in ${tenantName}` }]),
    ...members.filter(({ user }) => user.id !== ownerId && !granted.has(user.id)).map(({ user }) => ({ value: user.id, label: `${user.name} (${user.email})` })),
  ];
}

type AddShareProps = { calendar: Calendar; tenant: Tenant; shares: readonly Share[]; levels: readonly Level[]; onChanged: () => Promise<unknown> };

function AddShare({ calendar, tenant, shares, levels, onChanged }: AddShareProps) {
  // Always refetched on opening: the Admin screen's copy can predate a colleague who just joined.
  const organization = useQuery({ ...organizationQuery(tenant.id), staleTime: 0 });
  const create = $api.useMutation('post', SHARES);
  const [grantee, setGrantee] = useState('');
  const [access, setAccess] = useState<ShareAccess>('read');
  const [problem, setProblem] = useState<Problem | null>(null);
  const [exists, setExists] = useState(false);

  const members = organization.data?.members ?? [];
  const options = pickerOptions(members, shares, calendar.owner.id, tenant.name);
  // A refetch can take the chosen person out of the list.
  const chosen = options.some((option) => option.value === grantee) ? grantee : '';

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setProblem(null);
    setExists(false);
    try {
      await create.mutateAsync({
        params: { path: { id: calendar.id } },
        body: { grantee: chosen === EVERYONE ? { type: 'tenant' } : { type: 'user', userId: chosen }, access },
      });
      setGrantee('');
    } catch (failure) {
      if (isProblem(failure) && failure.status === 409) setExists(true);
      else setProblem(toProblem(failure));
    }
    await onChanged();
  }

  return (
    <form onSubmit={(event) => void submit(event)} className="grid gap-2">
      <div className="flex flex-wrap items-end gap-2">
        <label className="grid min-w-0 flex-1 basis-56 gap-1.5">
          <span className="text-sm font-semibold">Share with</span>
          <select value={chosen} onChange={(event) => setGrantee(event.target.value)} className="h-10 w-full rounded-lg border border-line-strong bg-surface px-3 text-[15px] shadow-xs">
            <option value="">Choose someone</option>
            {options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1.5">
          <span className="text-sm font-semibold">Access</span>
          <select
            value={access}
            onChange={(event) => {
              if (isShareAccess(event.target.value)) setAccess(event.target.value);
            }}
            className="h-10 rounded-lg border border-line-strong bg-surface px-3 text-[15px] shadow-xs"
          >
            {levels.map((level) => (
              <option key={level.value} value={level.value}>
                {level.label}
              </option>
            ))}
          </select>
        </label>
        <Button type="submit" variant="primary" disabled={chosen === '' || create.isPending} className="h-10">
          Share
        </Button>
      </div>
      {members.length >= MEMBER_CAP && <p className="text-[13px] text-ink-3">Only the first {MEMBER_CAP} members are listed.</p>}
      {organization.error && <ProblemAlert problem={toProblem(organization.error)} />}
      {problem && <ProblemAlert problem={problem} />}
      {exists && (
        <p role="alert" className="rounded-lg border border-warning/30 bg-warning-soft px-3.5 py-2.5 text-sm text-warning">
          A grant for them already exists. Change it in the list below.
        </p>
      )}
    </form>
  );
}

type ShareRowProps = { share: Share; calendarId: string; tenantName: string; levels: readonly Level[]; readOnly: boolean; onChanged: () => Promise<unknown> };

function ShareRow({ share, calendarId, tenantName, levels, readOnly, onChanged }: ShareRowProps) {
  const update = $api.useMutation('patch', SHARE);
  const remove = $api.useMutation('delete', SHARE);
  // The level being saved, shown until the refetch brings the row's new one.
  const [saving, setSaving] = useState<ShareAccess | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [removing, setRemoving] = useState(false);
  const [removeProblem, setRemoveProblem] = useState<Problem | null>(null);

  const everyone = share.grantee.type === 'tenant';
  const name = everyone ? `Everyone in ${tenantName}` : (share.user?.name ?? 'Unknown person');
  const path = { id: calendarId, shareId: share.id };

  async function changeAccess(access: ShareAccess) {
    setSaving(access);
    setProblem(null);
    try {
      await update.mutateAsync({ params: { path, header: { 'if-match': share.etag } }, body: { access } });
    } catch (failure) {
      const refused = toProblem(failure);
      setProblem(refused.status === 412 ? { type: 'about:blank', title: 'This share changed elsewhere', status: 412, detail: 'Its current access is shown here. Choose again if you still want to change it.' } : refused);
    }
    await onChanged();
    setSaving(null);
  }

  async function removeShare() {
    setRemoveProblem(null);
    try {
      await remove.mutateAsync({ params: { path } });
    } catch (failure) {
      setRemoveProblem(toProblem(failure));
      throw failure;
    } finally {
      await onChanged();
    }
  }

  return (
    <li aria-label={name} className="grid gap-2 py-3">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <p className="truncate text-[15px] font-semibold">{name}</p>
          {share.user && <p className="truncate text-[13px] text-ink-3">{share.user.email}</p>}
        </div>
        {readOnly ? (
          <Badge tone="accent">{levelOf(share.access).label}</Badge>
        ) : (
          <div className="flex items-center gap-2">
            <select
              aria-label={`Access for ${name}`}
              value={saving ?? share.access}
              disabled={saving !== null}
              onChange={(event) => {
                if (isShareAccess(event.target.value)) void changeAccess(event.target.value);
              }}
              className="h-8 rounded-lg border border-line-strong bg-surface px-2 text-sm"
            >
              {!levels.some((level) => level.value === share.access) && <option value={share.access} disabled>{levelOf(share.access).label} (currently read-only)</option>}
              {levels.map((level) => (
                <option key={level.value} value={level.value}>
                  {level.label}
                </option>
              ))}
            </select>
            <Button size="sm" variant="ghost" className="text-danger hover:text-danger" onClick={() => setRemoving(true)}>
              Remove
            </Button>
          </div>
        )}
      </div>
      {problem && <ProblemAlert problem={problem} />}
      <ConfirmDialog
        open={removing}
        onOpenChange={(open) => {
          setRemoving(open);
          if (!open) setRemoveProblem(null);
        }}
        title={`Remove access for ${name}?`}
        description={everyone ? 'This takes effect on each member’s next request. Personal grants stay.' : 'This takes effect on that person’s next request. An Everyone grant, if there is one, still applies to them.'}
        confirmLabel="Remove"
        danger
        error={removeProblem}
        onConfirm={removeShare}
      />
    </li>
  );
}
