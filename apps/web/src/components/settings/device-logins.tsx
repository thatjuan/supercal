/** Settings › Calendar apps: one CalDAV login per device; create (with a one-time reveal and setup steps) and revoke. */
import type { components, Problem } from '@supercal/api-client';
import { useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { $api } from '../../api.ts';
import { formatDate } from '../../lib/format.ts';
import { SecretReveal } from '../feeds/secret-reveal.tsx';
import { Button } from '../ui/button.tsx';
import { ConfirmDialog } from '../ui/confirm-dialog.tsx';
import { Dialog, DialogContent } from '../ui/dialog.tsx';
import { Field } from '../ui/field.tsx';
import { Panel } from '../ui/panel.tsx';
import { fieldErrors, ProblemAlert, toProblem } from '../ui/problem-alert.tsx';

type DavLogin = components['schemas']['DavLogin'];
type CreatedDavLogin = components['schemas']['CreatedDavLogin'];

export const davLoginsQuery = $api.queryOptions('get', '/api/v1/dav-logins');

export function DeviceLoginSettings() {
  const { data } = useSuspenseQuery(davLoginsQuery);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<CreatedDavLogin | null>(null);

  return (
    <Panel
      id="devices"
      title="Calendar apps"
      description="Give each device its own login to read and edit your hosted calendars. These logins work for CalDAV only; API keys are for applications."
      actions={
        <Button size="sm" onClick={() => setCreating(true)}>
          New device
        </Button>
      }
    >
      {data.items.length === 0 ? (
        <p className="text-sm text-ink-3">No devices yet.</p>
      ) : (
        <ul className="-my-2 divide-y divide-line">
          {data.items.map((login) => (
            <DeviceLoginRow key={login.id} login={login} />
          ))}
        </ul>
      )}
      <CreateLoginDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={(login) => {
          setCreating(false);
          setCreated(login);
        }}
      />
      <SecretReveal
        open={created !== null}
        onOpenChange={(open) => !open && setCreated(null)}
        title={`Calendar app login “${created?.name ?? ''}”`}
        secrets={
          created
            ? [
                { label: 'Server URL', value: created.serverUrl },
                { label: 'Username', value: created.username },
                { label: 'Password', value: created.password },
              ]
            : []
        }
      >
        <SetupSteps />
      </SecretReveal>
    </Panel>
  );
}

function SetupSteps() {
  return (
    <div className="grid gap-1.5 text-[13px] text-ink-2">
      <p className="font-semibold">Add it as a CalDAV account</p>
      <ul className="grid gap-1.5">
        <li>
          <span className="font-medium text-ink">Apple Calendar:</span> add an Other CalDAV Account. On a Mac, choose Manual as the account type. Enter all three values.
        </li>
        <li>
          <span className="font-medium text-ink">Thunderbird:</span> choose New Calendar, then On the Network. Enter the username and use the server URL as the location. It asks for the password next.
        </li>
        <li>
          <span className="font-medium text-ink">DAVx5:</span> add an account, choose Login with URL and user name, and enter all three values.
        </li>
      </ul>
    </div>
  );
}

function DeviceLoginRow({ login }: { login: DavLogin }) {
  const queryClient = useQueryClient();
  const remove = $api.useMutation('delete', '/api/v1/dav-logins/{id}');
  const [revoking, setRevoking] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);

  async function revoke() {
    try {
      await remove.mutateAsync({ params: { path: { id: login.id } } });
    } catch (failure) {
      setProblem(toProblem(failure));
      throw failure;
    }
    await queryClient.invalidateQueries({ queryKey: davLoginsQuery.queryKey });
  }

  return (
    <li aria-label={login.name} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 py-3">
      <div className="min-w-0">
        <p className="text-[15px] font-semibold wrap-anywhere">
          {login.name} <span className="font-mono text-xs font-normal text-ink-3">{login.username}</span>
        </p>
        <p className="text-[13px] text-ink-3">
          {login.lastUsedAt ? `Last used ${formatDate(login.lastUsedAt)}` : 'Never used'} · Created {formatDate(login.createdAt)}
        </p>
      </div>
      <Button size="sm" variant="ghost" className="text-danger hover:text-danger" onClick={() => setRevoking(true)}>
        Revoke
      </Button>
      <ConfirmDialog
        open={revoking}
        onOpenChange={(open) => {
          setRevoking(open);
          if (!open) setProblem(null);
        }}
        title={`Revoke “${login.name}”?`}
        description="This device stops syncing at once. Your other devices are not affected."
        confirmLabel="Revoke login"
        danger
        onConfirm={revoke}
        error={problem}
      />
    </li>
  );
}

function CreateLoginDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (open: boolean) => void; onCreated: (login: CreatedDavLogin) => void }) {
  const queryClient = useQueryClient();
  const create = $api.useMutation('post', '/api/v1/dav-logins');
  const [problem, setProblem] = useState<Problem | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setProblem(null);
    try {
      const created = await create.mutateAsync({ body: { name: String(form.get('name')).trim() } });
      await queryClient.invalidateQueries({ queryKey: davLoginsQuery.queryKey });
      onCreated(created);
    } catch (failure) {
      setProblem(toProblem(failure));
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) setProblem(null);
      }}
    >
      <DialogContent title="New device">
        <form onSubmit={submit} className="grid gap-3">
          {problem && <ProblemAlert problem={problem} />}
          <Field label="Name" name="name" placeholder="Work iPhone" required maxLength={100} autoFocus error={fieldErrors(problem).name} />
          <div className="flex justify-end">
            <Button type="submit" variant="primary" disabled={create.isPending}>
              Create login
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
