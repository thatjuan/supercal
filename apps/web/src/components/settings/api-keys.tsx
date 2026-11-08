/** Settings › API keys: the user's keys for this tenant; create (with a one-time reveal) and delete. */
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

type ApiKey = components['schemas']['ApiKey'];

const apiKeysQuery = $api.queryOptions('get', '/api/v1/api-keys');

const EXPIRY = [
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
  { days: 365, label: '1 year' },
  { days: 0, label: 'Never' },
] as const;


export function ApiKeySettings() {
  const { data } = useSuspenseQuery(apiKeysQuery);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<{ name: string; key: string } | null>(null);

  return (
    <Panel
      title="API keys"
      description={
        <>
          Keys act as you in this tenant. Send one as <span className="font-mono text-[13px]">Authorization: Bearer &lt;key&gt;</span>; see the{' '}
          <a href="/api/docs" target="_blank" rel="noreferrer" className="text-accent hover:underline">
            API reference
          </a>
          .
        </>
      }
      actions={
        <Button size="sm" onClick={() => setCreating(true)}>
          New key
        </Button>
      }
    >
      {data.items.length === 0 ? (
        <p className="text-sm text-ink-3">No API keys yet.</p>
      ) : (
        <ul className="-my-2 divide-y divide-line">
          {data.items.map((key) => (
            <ApiKeyRow key={key.id} apiKey={key} />
          ))}
        </ul>
      )}
      <CreateKeyDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={(key) => {
          setCreating(false);
          setCreated(key);
        }}
      />
      <SecretReveal
        open={created !== null}
        onOpenChange={(open) => !open && setCreated(null)}
        title={`API key “${created?.name ?? ''}”`}
        secrets={created ? [{ label: 'API key', value: created.key }] : []}
      />
    </Panel>
  );
}

function ApiKeyRow({ apiKey }: { apiKey: ApiKey }) {
  const queryClient = useQueryClient();
  const remove = $api.useMutation('delete', '/api/v1/api-keys/{id}');
  const [deleting, setDeleting] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const name = apiKey.name ?? 'Unnamed key';

  async function deleteKey() {
    try {
      await remove.mutateAsync({ params: { path: { id: apiKey.id } } });
    } catch (failure) {
      setProblem(toProblem(failure));
      throw failure;
    }
    await queryClient.invalidateQueries({ queryKey: apiKeysQuery.queryKey });
  }

  return (
    <li aria-label={name} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 py-3">
      <div className="min-w-0">
        <p className="text-[15px] font-semibold">
          {name} {apiKey.start && <span className="font-mono text-xs font-normal text-ink-3">{apiKey.start}…</span>}
        </p>
        <p className="text-[13px] text-ink-3">
          Created {formatDate(apiKey.createdAt)} · Last used {formatDate(apiKey.lastUsedAt, 'never')} · Expires {formatDate(apiKey.expiresAt, 'never')}
        </p>
      </div>
      <Button size="sm" variant="ghost" className="text-danger hover:text-danger" onClick={() => setDeleting(true)}>
        Delete
      </Button>
      <ConfirmDialog
        open={deleting}
        onOpenChange={(open) => {
          setDeleting(open);
          if (!open) setProblem(null);
        }}
        title={`Delete “${name}”?`}
        description="Anything using this key gets 401 from now on."
        confirmLabel="Delete key"
        danger
        onConfirm={deleteKey}
        error={problem}
      />
    </li>
  );
}

function CreateKeyDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (open: boolean) => void; onCreated: (key: { name: string; key: string }) => void }) {
  const queryClient = useQueryClient();
  const create = $api.useMutation('post', '/api/v1/api-keys');
  const [problem, setProblem] = useState<Problem | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const days = Number(form.get('expiresInDays'));
    setProblem(null);
    try {
      const created = await create.mutateAsync({ body: { name: String(form.get('name')).trim(), ...(days > 0 && { expiresInDays: days }) } });
      await queryClient.invalidateQueries({ queryKey: apiKeysQuery.queryKey });
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
      <DialogContent title="New API key">
        <form onSubmit={submit} className="grid gap-3">
          {problem && <ProblemAlert problem={problem} />}
          <Field label="Name" name="name" placeholder="Home automation" required maxLength={32} autoFocus error={fieldErrors(problem).name} />
          <label className="grid gap-1.5">
            <span className="text-sm font-semibold">Expires after</span>
            <select name="expiresInDays" defaultValue={90} className="h-10 rounded-lg border border-line-strong bg-surface px-3 text-[15px] shadow-xs">
              {EXPIRY.map((option) => (
                <option key={option.days} value={option.days}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <div className="flex justify-end">
            <Button type="submit" variant="primary" disabled={create.isPending}>
              Create key
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
