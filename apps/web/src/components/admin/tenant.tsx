/** Tenant admin › Tenant: name and slug, editable by owners (`PATCH /api/v1/tenant`). */
import type { components, Problem } from '@supercal/api-client';
import { useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { $api, meQuery } from '../../api.ts';
import { Button } from '../ui/button.tsx';
import { Field } from '../ui/field.tsx';
import { Panel } from '../ui/panel.tsx';
import { fieldErrors, ProblemAlert, toProblem } from '../ui/problem-alert.tsx';

type Tenant = components['schemas']['Tenant'];

export function TenantSettings({ tenant, editable }: { tenant: Tenant; editable: boolean }) {
  const queryClient = useQueryClient();
  const update = $api.useMutation('patch', '/api/v1/tenant');
  const [problem, setProblem] = useState<Problem | null>(null);
  const [saved, setSaved] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setProblem(null);
    setSaved(false);
    try {
      await update.mutateAsync({ body: { name: String(form.get('name')).trim(), slug: String(form.get('slug')).trim() } });
      await queryClient.invalidateQueries({ queryKey: meQuery.queryKey });
      setSaved(true);
    } catch (failure) {
      setProblem(toProblem(failure));
    }
  }

  const errors = fieldErrors(problem);
  return (
    <Panel title="Tenant" description={editable ? undefined : 'Only owners can change these.'}>
      <form onSubmit={submit} className="grid max-w-md gap-3">
        {problem && <ProblemAlert problem={problem} />}
        <Field label="Name" name="name" defaultValue={tenant.name} required maxLength={100} readOnly={!editable} error={errors.name} />
        <Field
          label="Slug"
          name="slug"
          defaultValue={tenant.slug}
          required
          minLength={2}
          maxLength={64}
          pattern="[a-z0-9]+(-[a-z0-9]+)*"
          readOnly={!editable}
          hint="Lowercase letters, digits and single hyphens."
          error={errors.slug}
          className="font-mono"
        />
        {editable && (
          <div className="flex items-center gap-3">
            <Button type="submit" disabled={update.isPending}>
              Save
            </Button>
            {saved && (
              <span role="status" className="text-sm text-accent-text">
                Saved.
              </span>
            )}
          </div>
        )}
      </form>
    </Panel>
  );
}
