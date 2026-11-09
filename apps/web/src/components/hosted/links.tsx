/**
 * A hosted calendar's Links tab: view-only ICS URLs for people without an account. A new link's token
 * is returned once, so creating goes through `client.POST` and the result lives only in this tab's
 * state until the reveal closes: never in a query key, the mutation cache or the address bar.
 */
import { Temporal } from '@js-temporal/polyfill';
import type { components, Problem } from '@supercal/api-client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { $api, client } from '../../api.ts';
import { formatDate } from '../../lib/format.ts';
import { browserZone } from '../../lib/zones.ts';
import { PrivacyBadge, PrivacyPicker } from '../calendars/privacy.tsx';
import type { Privacy } from '../calendars/data.ts';
import { FALLBACK_COLOR } from '../calendars/settings-fields.tsx';
import { SecretReveal } from '../feeds/secret-reveal.tsx';
import { Button, buttonClass } from '../ui/button.tsx';
import { ConfirmDialog } from '../ui/confirm-dialog.tsx';
import { Dialog, DialogClose, DialogContent } from '../ui/dialog.tsx';
import { Field } from '../ui/field.tsx';
import { Panel } from '../ui/panel.tsx';
import { fieldErrors, ProblemAlert, toProblem } from '../ui/problem-alert.tsx';
import { QrButton } from '../ui/qr-code.tsx';
import type { CalendarTabProps, HostedCalendar } from './data.ts';

type CalendarLink = components['schemas']['CalendarLink'];
type CreatedLink = components['schemas']['CreatedCalendarLink'];

const LINKS = '/api/v1/calendars/{id}/links';
const LINK = '/api/v1/calendars/{id}/links/{linkId}';

const EXPIRY_IN_PAST = 'Choose a time in the future.';
const UNTITLED = 'Untitled link';

/** A stored expiry as a `datetime-local` value, in the browser's zone. */
const toLocalInput = (iso: string | null) => (iso ? Temporal.Instant.from(iso).toZonedDateTimeISO(browserZone).toPlainDateTime().toString({ smallestUnit: 'minute' }) : '');
/** A `datetime-local` value as the instant it means in the browser's zone. */
const toInstant = (local: string) => Temporal.PlainDateTime.from(local).toZonedDateTime(browserZone).toInstant();
const isPast = (instant: Temporal.Instant) => Temporal.Instant.compare(instant, Temporal.Now.instant()) <= 0;

export function LinksTab({ loaded: { calendar } }: CalendarTabProps) {
  const queryClient = useQueryClient();
  const linksQuery = $api.queryOptions('get', LINKS, { params: { path: { id: calendar.id } } });
  const links = useQuery(linksQuery);
  const refresh = () => queryClient.invalidateQueries({ queryKey: linksQuery.queryKey });
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<CreatedLink | null>(null);

  return (
    <Panel
      title="Links"
      description="Anyone with a link’s URL can subscribe without an account. The URL is shown only when the link is created and can’t be recovered: if it’s lost, create a new link."
      actions={
        <Button size="sm" onClick={() => setCreating(true)}>
          New link
        </Button>
      }
    >
      {links.error && <ProblemAlert problem={toProblem(links.error)} />}
      {links.data &&
        (links.data.items.length === 0 ? (
          <p className="text-sm text-ink-3">No published links yet.</p>
        ) : (
          <ul aria-label="Published links" className="-my-2 divide-y divide-line">
            {links.data.items.map((link) => (
              <LinkRow key={link.id} link={link} calendarId={calendar.id} onChanged={refresh} />
            ))}
          </ul>
        ))}
      {creating && (
        <CreateLinkDialog
          calendar={calendar}
          onClose={() => setCreating(false)}
          onCreated={(link) => {
            setCreating(false);
            setCreated(link);
            void refresh();
          }}
        />
      )}
      {created && (
        <SecretReveal
          open
          onOpenChange={(open) => {
            if (!open) setCreated(null);
          }}
          title={`Link “${created.name ?? UNTITLED}”`}
          secrets={[
            { label: 'Subscribe URL', value: created.url },
            { label: 'Calendar app URL', value: created.webcalUrl },
          ]}
        >
          <div className="flex flex-wrap items-center gap-2">
            <a href={created.subscribe.google} target="_blank" rel="noreferrer" className={buttonClass({ size: 'sm' })}>
              Add to Google Calendar
            </a>
            <a href={created.subscribe.outlookPersonal} target="_blank" rel="noreferrer" className={buttonClass({ size: 'sm' })}>
              Add to Outlook.com
            </a>
            <a href={created.subscribe.outlookWork} target="_blank" rel="noreferrer" className={buttonClass({ size: 'sm' })}>
              Add to Outlook (work)
            </a>
            <QrButton value={created.webcalUrl} title="Calendar app URL" />
          </div>
        </SecretReveal>
      )}
    </Panel>
  );
}

function LinkRow({ link, calendarId, onChanged }: { link: CalendarLink; calendarId: string; onChanged: () => Promise<unknown> }) {
  const remove = $api.useMutation('delete', LINK);
  const [editing, setEditing] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const name = link.name ?? UNTITLED;
  const expired = link.expiresAt !== null && isPast(Temporal.Instant.from(link.expiresAt));

  async function revoke() {
    setProblem(null);
    try {
      await remove.mutateAsync({ params: { path: { id: calendarId, linkId: link.id } } });
    } catch (failure) {
      setProblem(toProblem(failure));
      throw failure;
    }
    await onChanged();
  }

  return (
    <li aria-label={name} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 py-3">
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-2 text-[15px] font-semibold">
          <span className="min-w-0 wrap-anywhere">{name}</span>
          <PrivacyBadge privacy={link.privacy} />
        </p>
        <p className="mt-0.5 text-[13px] text-ink-3">
          Created {formatDate(link.createdAt)} · {expired ? <span className="font-medium text-danger">Expired</span> : link.expiresAt ? `Expires ${formatDate(link.expiresAt)}` : 'No expiry'}
        </p>
      </div>
      <div className="flex items-center gap-1">
        <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
          Edit
        </Button>
        <Button size="sm" variant="ghost" className="text-danger hover:text-danger" onClick={() => setRevoking(true)}>
          Revoke
        </Button>
      </div>
      {editing && <EditLinkDialog link={link} calendarId={calendarId} onClose={() => setEditing(false)} onSaved={onChanged} />}
      <ConfirmDialog
        open={revoking}
        onOpenChange={(open) => {
          setRevoking(open);
          if (!open) setProblem(null);
        }}
        title={`Revoke “${name}”?`}
        description="Subscribers lose access at once."
        confirmLabel="Revoke link"
        danger
        error={problem}
        onConfirm={revoke}
      />
    </li>
  );
}

type CreateLinkDialogProps = { calendar: HostedCalendar; onClose: () => void; onCreated: (link: CreatedLink) => void };

/** Privacy starts unset, so nobody publishes full details by accident. Mounted only while open, so it starts empty each time. */
function CreateLinkDialog({ calendar, onClose, onCreated }: CreateLinkDialogProps) {
  const [name, setName] = useState('');
  const [privacy, setPrivacy] = useState<Privacy | null>(null);
  const [expires, setExpires] = useState('');
  const [expiryError, setExpiryError] = useState<string>();
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!privacy) return;
    const expiresAt = expires ? toInstant(expires) : null;
    setExpiryError(expiresAt && isPast(expiresAt) ? EXPIRY_IN_PAST : undefined);
    if (expiresAt && isPast(expiresAt)) return;
    setPending(true);
    setProblem(null);
    try {
      const { data, error } = await client.POST(LINKS, {
        params: { path: { id: calendar.id } },
        body: { privacy, ...(name.trim() && { name: name.trim() }), ...(expiresAt && { expiresAt: expiresAt.toString() }) },
      });
      if (error) setProblem(toProblem(error));
      else onCreated(data);
    } catch (failure) {
      setProblem(toProblem(failure));
    }
    setPending(false);
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent title="New published link" className="max-h-[calc(100dvh-2rem)] w-[min(34rem,calc(100vw-2rem))] overflow-y-auto">
        <form onSubmit={(event) => void submit(event)} className="grid gap-4">
          {problem && <ProblemAlert problem={problem} />}
          <Field label="Name (optional)" value={name} maxLength={100} placeholder="Personal website" error={fieldErrors(problem).name} onChange={(event) => setName(event.target.value)} />
          <div className="grid gap-2">
            <PrivacyPicker value={privacy} onChange={setPrivacy} color={calendar.color ?? FALLBACK_COLOR} />
            <p className="text-[13px] text-ink-3">
              With Full, titles, descriptions, locations and links are public. Attendees, organizer, reminders and comments are always left out, and private events always show as “Busy”.
            </p>
          </div>
          <Field
            label="Expires (optional)"
            type="datetime-local"
            value={expires}
            error={expiryError ?? fieldErrors(problem).expiresAt}
            onChange={(event) => {
              setExpires(event.target.value);
              setExpiryError(undefined);
            }}
          />
          <div className="flex justify-end gap-2">
            <DialogClose asChild>
              <Button>Cancel</Button>
            </DialogClose>
            <Button type="submit" variant="primary" disabled={privacy === null || pending}>
              Create
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

type EditLinkDialogProps = { link: CalendarLink; calendarId: string; onClose: () => void; onSaved: () => Promise<unknown> };

/**
 * Edits name and expiry; `null` clears either. Sends only what changed: the server refuses a past
 * expiry, so resending the one on an expired link would stop its name being edited.
 */
function EditLinkDialog({ link, calendarId, onClose, onSaved }: EditLinkDialogProps) {
  const update = $api.useMutation('patch', LINK);
  const initialExpires = toLocalInput(link.expiresAt);
  const [name, setName] = useState(link.name ?? '');
  const [expires, setExpires] = useState(initialExpires);
  const [expiryError, setExpiryError] = useState<string>();
  const [problem, setProblem] = useState<Problem | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const expiresChanged = expires !== initialExpires;
    const expiresAt = expires ? toInstant(expires) : null;
    if (expiresChanged && expiresAt && isPast(expiresAt)) return setExpiryError(EXPIRY_IN_PAST);
    const trimmed = name.trim();
    const body = {
      ...(trimmed !== (link.name ?? '') && { name: trimmed || null }),
      ...(expiresChanged && { expiresAt: expiresAt?.toString() ?? null }),
    };
    if (Object.keys(body).length === 0) return onClose();
    setExpiryError(undefined);
    setProblem(null);
    try {
      await update.mutateAsync({ params: { path: { id: calendarId, linkId: link.id } }, body });
      await onSaved();
      onClose();
    } catch (failure) {
      setProblem(toProblem(failure));
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent title="Edit link">
        <form onSubmit={(event) => void submit(event)} className="grid gap-4">
          {problem && <ProblemAlert problem={problem} />}
          <Field label="Name (optional)" value={name} maxLength={100} error={fieldErrors(problem).name} onChange={(event) => setName(event.target.value)} />
          <Field
            label="Expires (optional)"
            type="datetime-local"
            value={expires}
            hint="Leave empty for no expiry."
            error={expiryError ?? fieldErrors(problem).expiresAt}
            onChange={(event) => {
              setExpires(event.target.value);
              setExpiryError(undefined);
            }}
          />
          <div className="grid gap-1.5">
            <p className="text-sm font-semibold">Privacy</p>
            <PrivacyBadge privacy={link.privacy} />
            <p className="text-[13px] text-ink-3">To change privacy, create a new link.</p>
          </div>
          <div className="flex justify-end gap-2">
            <DialogClose asChild>
              <Button>Cancel</Button>
            </DialogClose>
            <Button type="submit" variant="primary" disabled={update.isPending}>
              Save
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
