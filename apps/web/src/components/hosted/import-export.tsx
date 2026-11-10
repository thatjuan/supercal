/** Export a hosted calendar as `.ics` (from `read`) and import an `.ics` file into it (from `write`). */
import type { operations, Problem } from '@supercal/api-client';
import { useId, useState, type FormEvent } from 'react';
import { client } from '../../api.ts';
import { buttonClass, Button } from '../ui/button.tsx';
import { Panel } from '../ui/panel.tsx';
import { ProblemAlert, toProblem } from '../ui/problem-alert.tsx';
import { atLeast, type Calendar } from './data.ts';

type OnConflict = NonNullable<NonNullable<operations['importCalendar']['parameters']['query']>['onConflict']>;
type ImportResult = operations['importCalendar']['responses'][200]['content']['application/json'];

/** The same limit as the server's 413, so a too-large file fails before it is uploaded. */
export const MAX_IMPORT_BYTES = 8 * 1024 * 1024;

export function ImportExport({ calendar }: { calendar: Calendar }) {
  const canImport = atLeast(calendar.access, 'write') && calendar.state === 'active';
  return (
    <Panel title="Import and export" description="Move events in and out as an iCalendar (.ics) file.">
      <div className="grid gap-5">
        <div>
          <a href={`/api/v1/calendars/${calendar.id}/export.ics`} download={`${calendar.name}.ics`} className={buttonClass()}>
            Export .ics
          </a>
        </div>
        {canImport && <ImportForm id={calendar.id} />}
      </div>
    </Panel>
  );
}

function ImportForm({ id }: { id: string }) {
  const conflictId = useId();
  const [file, setFile] = useState<File | null>(null);
  const [onConflict, setOnConflict] = useState<OnConflict>('skip');
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const tooLarge = file !== null && file.size > MAX_IMPORT_BYTES;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!file || tooLarge) return;
    setPending(true);
    setProblem(null);
    setResult(null);
    try {
      const { data, error } = await client.POST('/api/v1/calendars/{id}/import', {
        params: { path: { id }, query: { onConflict } },
        body: await file.text(),
        bodySerializer: (body) => body,
        headers: { 'Content-Type': 'text/calendar' },
      });
      if (error) throw error;
      setResult(data);
    } catch (failure) {
      setProblem(toProblem(failure));
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={(event) => void submit(event)} className="grid gap-3 border-t border-line pt-4">
      {problem && <ProblemAlert problem={problem} />}
      <label className="grid gap-1.5">
        <span className="text-sm font-semibold">Calendar file</span>
        <input
          type="file"
          accept=".ics,text/calendar"
          aria-invalid={tooLarge || undefined}
          onChange={(event) => {
            setFile(event.target.files?.[0] ?? null);
            setProblem(null);
            setResult(null);
          }}
          className="text-sm text-ink-2 file:me-3 file:h-9 file:rounded-[9px] file:border file:border-line file:bg-surface file:px-4 file:text-[15px] file:font-medium file:text-ink file:shadow-xs"
        />
        {tooLarge && (
          <span role="alert" className="text-[13px] text-danger">
            This file is over the 8 MiB limit. Split it into smaller files and import each one.
          </span>
        )}
      </label>
      <div className="grid gap-1.5">
        <label htmlFor={conflictId} className="text-sm font-semibold">
          When an event already exists
        </label>
        <select id={conflictId} value={onConflict} onChange={(event) => setOnConflict(event.target.value === 'replace' ? 'replace' : 'skip')} className="h-10 rounded-lg border border-line-strong bg-surface px-3 text-[15px] text-ink shadow-xs">
          <option value="skip">Skip events with the same UID</option>
          <option value="replace">Replace events with the same UID</option>
        </select>
      </div>
      <div className="flex justify-end">
        <Button type="submit" variant="primary" disabled={!file || tooLarge || pending}>
          {pending ? 'Importing…' : 'Import'}
        </Button>
      </div>
      {result && <ImportSummary result={result} />}
    </form>
  );
}

function ImportSummary({ result }: { result: ImportResult }) {
  return (
    <div role="status" className="grid gap-2 rounded-lg border border-line bg-surface-2 px-3.5 py-2.5 text-sm">
      <p>
        {result.created} created · {result.updated} updated · {result.skipped} skipped · {result.failed.length} failed
      </p>
      {result.failed.length > 0 && (
        <ul className="grid gap-1 text-[13px] text-danger">
          {result.failed.map((failure, index) => (
            <li key={`${failure.uid}-${index}`} className="wrap-anywhere">
              <span className="font-mono">{failure.uid || 'No UID'}</span>: {failure.reason}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
