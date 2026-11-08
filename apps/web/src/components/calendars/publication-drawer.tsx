/**
 * The publication settings drawer, opened from a calendar row or a virtual calendar. Saves only the
 * changed fields with `PATCH` + `If-Match`, says beforehand when the change makes calendar apps
 * re-download the calendar, and walks the user through a 412 (see `usePublicationEditor`).
 */
import type { components, Problem } from '@supercal/api-client';
import { useState, type FormEvent } from 'react';
import { isProblem } from '../../api.ts';
import { Button } from '../ui/button.tsx';
import { ProblemAlert, toProblem } from '../ui/problem-alert.tsx';
import type { Publication } from './data.ts';
import { SettingsFields } from './settings-fields.tsx';
import { diffSettings, EPOCH_NOTE, settingsOf } from './settings.ts';
import { Sheet } from './sheet.tsx';
import { CONFLICT_MESSAGE, usePublicationEditor } from './use-publication-editor.ts';

type Patch = components['schemas']['PublicationPatch'];

type FormProps = {
  publication: Publication;
  fallbackColor: string | null;
  onSave: (patch: Patch) => void;
  onCancel: () => void;
  pending: boolean;
  conflict: boolean;
  problem: Problem | null;
};

/** The settings form for one loaded publication; remount it (by ETag) to start from a newer version. */
export function PublicationForm({ publication, fallbackColor, onSave, onCancel, pending, conflict, problem }: FormProps) {
  const base = settingsOf(publication);
  const [draft, setDraft] = useState(base);
  const { patch, bumpsEpoch } = diffSettings(base, draft);
  const dirty = Object.keys(patch).length > 0;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (dirty) onSave(patch);
  };

  return (
    <form onSubmit={submit} className="grid gap-5 px-5 py-5">
      {conflict && (
        <p role="alert" className="rounded-lg border border-warning/30 bg-warning-soft px-3.5 py-2.5 text-sm text-warning">
          {CONFLICT_MESSAGE}
        </p>
      )}
      {problem && <ProblemAlert problem={problem} showFieldErrors />}
      <SettingsFields value={draft} onChange={setDraft} fallbackColor={fallbackColor} />
      <footer className="sticky bottom-0 -mx-5 -mb-5 flex flex-wrap items-center justify-end gap-2 border-t border-line bg-surface px-5 py-3">
        {bumpsEpoch && (
          <p role="note" className="mr-auto text-[13px] text-ink-2">
            {EPOCH_NOTE}
          </p>
        )}
        <Button onClick={onCancel}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={!dirty || pending || draft.name.trim() === ''}>
          {pending ? 'Saving…' : 'Save'}
        </Button>
      </footer>
    </form>
  );
}

/** Loads `publicationId` and edits it in a drawer. */
export function PublicationDrawer({ publicationId, fallbackColor, onClose }: { publicationId: string; fallbackColor: string | null; onClose: () => void }) {
  const { query, save, conflict } = usePublicationEditor(publicationId);
  const problem = save.error && !(isProblem(save.error) && save.error.status === 412) ? toProblem(save.error) : null;
  const loaded = query.data;

  return (
    <Sheet
      open
      onOpenChange={(open) => !open && onClose()}
      title={loaded ? loaded.publication.name : 'Publication settings'}
      description={loaded?.publication.kind === 'virtual' ? 'Virtual calendar settings' : 'How this calendar is published'}
    >
      {query.error && <ProblemAlert problem={toProblem(query.error)} className="m-5" />}
      {loaded && (
        <PublicationForm
          key={loaded.etag}
          publication={loaded.publication}
          fallbackColor={fallbackColor}
          onSave={(patch) => save.mutate(patch, { onSuccess: onClose })}
          onCancel={onClose}
          pending={save.isPending}
          conflict={conflict}
          problem={problem}
        />
      )}
    </Sheet>
  );
}
