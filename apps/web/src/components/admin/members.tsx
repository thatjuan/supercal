/**
 * Tenant admin › Members: members with roles, pending invitations with their copyable links, and
 * invite, change role (owners) and remove. All of it goes through Better Auth's organization API.
 * Invitation email is not wired yet (no `sendInvitationEmail`), so the link is what the admin hands over.
 */
import type { Problem } from '@supercal/api-client';
import { queryOptions, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { authClient } from '../../auth.ts';
import { Badge } from '../ui/badge.tsx';
import { Button } from '../ui/button.tsx';
import { ConfirmDialog } from '../ui/confirm-dialog.tsx';
import { CopyField } from '../ui/copy.tsx';
import { Field } from '../ui/field.tsx';
import { Panel } from '../ui/panel.tsx';
import { ProblemAlert, toProblem } from '../ui/problem-alert.tsx';

export type Role = 'member' | 'admin' | 'owner';

const ROLE_LABEL: Record<Role, string> = { owner: 'Owner', admin: 'Admin', member: 'Member' };
const isRole = (value: string): value is Role => value in ROLE_LABEL;

/** The active tenant with its members (and their users) and invitations. */
export const organizationQuery = (tenantId: string) =>
  queryOptions({
    queryKey: ['auth', 'organization', tenantId],
    queryFn: async () => {
      const { data, error } = await authClient.organization.getFullOrganization();
      if (error) throw toProblem(error);
      if (!data) throw toProblem({ message: 'No active tenant', status: 404 });
      return data;
    },
  });

export const inviteUrl = (invitationId: string) => `${window.location.origin}/invite/${invitationId}`;

type MembersProps = { tenantId: string; myRole: Role; myUserId: string };

export function Members({ tenantId, myRole, myUserId }: MembersProps) {
  const organization = useQuery(organizationQuery(tenantId));
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: organizationQuery(tenantId).queryKey });
  const [problem, setProblem] = useState<Problem | null>(null);
  const [removing, setRemoving] = useState<{ id: string; name: string } | null>(null);

  /** Runs a Better Auth call, surfacing its error and refreshing the list after. */
  async function act(call: () => Promise<{ error: unknown }>) {
    setProblem(null);
    const { error } = await call();
    if (error) {
      setProblem(toProblem(error));
      throw error;
    }
    await refresh();
  }

  if (organization.error) return <ProblemAlert problem={toProblem(organization.error)} />;
  const pending = organization.data?.invitations.filter((invitation) => invitation.status === 'pending') ?? [];

  return (
    <Panel title="Members" description="Members manage their own accounts and feeds; admins manage everyone’s; owners also manage the tenant and roles.">
      <div className="grid gap-5">
        <InviteForm onInvited={refresh} />
        {problem && <ProblemAlert problem={problem} />}
        <ul aria-label="Members" className="divide-y divide-line border-y border-line">
          {organization.data?.members.map((member) => {
            const role = isRole(member.role) ? member.role : 'member';
            const isMe = member.userId === myUserId;
            return (
              <li key={member.id} aria-label={member.user.name} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3">
                <div className="min-w-0">
                  <p className="truncate text-[15px] font-semibold">
                    {member.user.name} {isMe && <span className="font-normal text-ink-3">(you)</span>}
                  </p>
                  <p className="truncate text-[13px] text-ink-3">{member.user.email}</p>
                </div>
                <div className="flex items-center gap-2">
                  {myRole === 'owner' && !isMe ? (
                    <select
                      aria-label={`Role of ${member.user.name}`}
                      value={role}
                      onChange={(event) =>
                        void act(() => authClient.organization.updateMemberRole({ memberId: member.id, role: event.target.value })).catch(() => undefined)
                      }
                      className="h-8 rounded-lg border border-line-strong bg-surface px-2 text-sm"
                    >
                      {Object.entries(ROLE_LABEL).map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <Badge tone={role === 'member' ? 'neutral' : 'accent'}>{ROLE_LABEL[role]}</Badge>
                  )}
                  {!isMe && (role !== 'owner' || myRole === 'owner') && (
                    <Button size="sm" variant="ghost" className="text-danger hover:text-danger" onClick={() => setRemoving({ id: member.id, name: member.user.name })}>
                      Remove
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
        {pending.length > 0 && (
          <div className="grid gap-3">
            <h3 className="text-[15px] font-semibold">Pending invitations</h3>
            <ul className="grid gap-3">
              {pending.map((invitation) => (
                <li key={invitation.id} aria-label={`Invitation for ${invitation.email}`} className="grid gap-2 rounded-lg border border-line px-3.5 py-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-[15px]">
                      {invitation.email} <Badge className="ml-1">{isRole(invitation.role) ? ROLE_LABEL[invitation.role] : invitation.role}</Badge>
                    </span>
                    <Button size="sm" variant="ghost" onClick={() => void act(() => authClient.organization.cancelInvitation({ invitationId: invitation.id })).catch(() => undefined)}>
                      Cancel
                    </Button>
                  </div>
                  <CopyField label="Invite link" value={inviteUrl(invitation.id)} copyLabel={`Copy invite link for ${invitation.email}`} />
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
        title={`Remove ${removing?.name ?? ''}?`}
        description="They lose access to this tenant at once. Their accounts and feeds here are kept."
        confirmLabel="Remove"
        danger
        error={problem}
        onConfirm={() => act(() => authClient.organization.removeMember({ memberIdOrEmail: removing?.id ?? '' }))}
      />
    </Panel>
  );
}

/** Invite by email; the new invitation's link appears in the pending list to copy. */
function InviteForm({ onInvited }: { onInvited: () => Promise<unknown> }) {
  const [problem, setProblem] = useState<Problem | null>(null);
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const email = String(data.get('email')).trim();
    const role = data.get('role') === 'admin' ? 'admin' : 'member';
    setPending(true);
    setProblem(null);
    setSent(null);
    const { error } = await authClient.organization.inviteMember({ email, role });
    setPending(false);
    if (error) return setProblem(toProblem(error));
    form.reset();
    setSent(email);
    await onInvited();
  }

  return (
    <form onSubmit={submit} className="grid gap-2">
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-0 flex-1 basis-56">
          <Field label="Invite by email" name="email" type="email" required placeholder="name@example.com" autoComplete="off" />
        </div>
        <label className="grid gap-1.5">
          <span className="text-sm font-semibold">Role</span>
          <select name="role" defaultValue="member" className="h-10 rounded-lg border border-line-strong bg-surface px-3 text-[15px] shadow-xs">
            <option value="member">Member</option>
            <option value="admin">Admin</option>
          </select>
        </label>
        <Button type="submit" variant="primary" disabled={pending} className="h-10">
          Invite
        </Button>
      </div>
      {problem && <ProblemAlert problem={problem} />}
      {sent && (
        <p role="status" className="text-sm text-accent-text">
          Invitation created for {sent}. Supercal does not email invitations yet: copy the link below and send it yourself.
        </p>
      )}
    </form>
  );
}
