/**
 * Settings › Feeds: the user's feeds, extra feeds (create, rename, delete; never the default), and
 * per-feed credential rotation with a one-time reveal.
 */
import type { components, Problem } from '@supercal/api-client';
import { useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { $api } from '../../api.ts';
import { rememberFeedSecrets } from '../../secrets.ts';
import { feedsQuery } from '../feeds/queries.ts';
import { RotateCredential } from '../feeds/rotate-credential.tsx';
import { SecretReveal, type Secret } from '../feeds/secret-reveal.tsx';
import { Badge } from '../ui/badge.tsx';
import { Button } from '../ui/button.tsx';
import { ConfirmDialog } from '../ui/confirm-dialog.tsx';
import { Dialog, DialogContent } from '../ui/dialog.tsx';
import { Field } from '../ui/field.tsx';
import { Panel } from '../ui/panel.tsx';
import { fieldErrors, ProblemAlert, toProblem } from '../ui/problem-alert.tsx';

type Feed = components['schemas']['Feed'];

export function FeedSettings() {
  const { data } = useSuspenseQuery(feedsQuery);
  const queryClient = useQueryClient();
  const create = $api.useMutation('post', '/api/v1/feeds');
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<readonly Secret[] | null>(null);

  async function createFeed(name: string) {
    const { feed, credentials } = await create.mutateAsync({ body: { name } });
    rememberFeedSecrets(feed.id, { icsToken: credentials.ics.token, caldavPassword: credentials.caldav.password });
    await queryClient.invalidateQueries({ queryKey: feedsQuery.queryKey });
    setCreating(false);
    setCreated([
      { label: 'CalDAV username', value: credentials.caldav.username },
      { label: 'CalDAV password', value: credentials.caldav.password },
      { label: 'ICS link (combined)', value: credentials.ics.urls.combined },
    ]);
  }

  return (
    <Panel
      title="Feeds"
      description="Each feed has its own publications, CalDAV login and ICS link. Share an extra feed (such as busy-only) with an assistant."
      actions={
        <Button size="sm" onClick={() => setCreating(true)}>
          New feed
        </Button>
      }
    >
      <ul className="-my-2 divide-y divide-line">
        {data.items.map((feed) => (
          <FeedRow key={feed.id} feed={feed} />
        ))}
      </ul>
      <NameDialog
        open={creating}
        onOpenChange={setCreating}
        title="New feed"
        submitLabel="Create feed"
        placeholder="Assistant (busy-only)"
        onSubmit={createFeed}
      />
      <SecretReveal open={created !== null} onOpenChange={(open) => !open && setCreated(null)} title="Feed created" secrets={created ?? []}>
        <p className="text-sm text-ink-2">Add calendars to it on the Calendars screen; the Subscribe screen has every link while this page stays open.</p>
      </SecretReveal>
    </Panel>
  );
}

function FeedRow({ feed }: { feed: Feed }) {
  const queryClient = useQueryClient();
  const rename = $api.useMutation('patch', '/api/v1/feeds/{id}');
  const remove = $api.useMutation('delete', '/api/v1/feeds/{id}');
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const params = { params: { path: { id: feed.id } } };

  async function renameFeed(name: string) {
    await rename.mutateAsync({ ...params, body: { name } });
    await queryClient.invalidateQueries({ queryKey: feedsQuery.queryKey });
    setRenaming(false);
  }

  async function deleteFeed() {
    try {
      await remove.mutateAsync(params);
    } catch (failure) {
      setProblem(toProblem(failure));
      throw failure;
    }
    await queryClient.invalidateQueries({ queryKey: feedsQuery.queryKey });
  }

  return (
    <li className="grid gap-2.5 py-3.5" aria-label={feed.name}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-[15px] font-semibold">{feed.name}</span>
        {feed.isDefault && <Badge>Default</Badge>}
        <span className="font-mono text-xs text-ink-3">CalDAV user {feed.caldavUsername}</span>
      </div>
      <div className="flex flex-wrap gap-2">
        <Link
          to="/feeds/$feedId/subscribe"
          params={{ feedId: feed.id }}
          className="inline-flex h-7 items-center rounded-[9px] border border-line bg-surface px-2.5 text-[13px] font-medium shadow-xs hover:bg-surface-2"
        >
          Subscribe
        </Link>
        <RotateCredential feedId={feed.id} kind="ics" size="sm" label="Rotate ICS link" />
        <RotateCredential feedId={feed.id} kind="caldav" size="sm" label="Rotate CalDAV password" />
        <Button size="sm" variant="ghost" onClick={() => setRenaming(true)}>
          Rename
        </Button>
        {!feed.isDefault && (
          <Button size="sm" variant="ghost" className="text-danger hover:text-danger" onClick={() => setDeleting(true)}>
            Delete
          </Button>
        )}
      </div>
      <NameDialog open={renaming} onOpenChange={setRenaming} title="Rename feed" submitLabel="Save" defaultValue={feed.name} onSubmit={renameFeed} />
      <ConfirmDialog
        open={deleting}
        onOpenChange={(open) => {
          setDeleting(open);
          if (!open) setProblem(null);
        }}
        title={`Delete “${feed.name}”?`}
        description="Its publications, CalDAV login and ICS links stop working for everyone subscribed. Source calendars are not touched."
        confirmLabel="Delete feed"
        danger
        onConfirm={deleteFeed}
        error={problem}
      />
    </li>
  );
}

type NameDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  submitLabel: string;
  defaultValue?: string;
  placeholder?: string;
  onSubmit: (name: string) => Promise<void>;
};

/** A one-field dialog for a feed's name; shows the server's problem when `onSubmit` throws. */
function NameDialog({ open, onOpenChange, title, submitLabel, defaultValue, placeholder, onSubmit }: NameDialogProps) {
  const [problem, setProblem] = useState<Problem | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setProblem(null);
    try {
      await onSubmit(String(new FormData(event.currentTarget).get('name')).trim());
    } catch (failure) {
      setProblem(toProblem(failure));
    } finally {
      setPending(false);
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
      <DialogContent title={title}>
        <form onSubmit={submit} className="grid gap-3">
          {problem && <ProblemAlert problem={problem} />}
          <Field label="Name" name="name" defaultValue={defaultValue} placeholder={placeholder} required maxLength={100} autoFocus error={fieldErrors(problem).name} />
          <div className="flex justify-end">
            <Button type="submit" variant="primary" disabled={pending}>
              {submitLabel}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
