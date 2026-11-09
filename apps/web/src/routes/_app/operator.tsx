/** Operator: every tenant in the install, and creating one with its first owner. Operators only. */
import type { Problem } from '@supercal/api-client';
import { useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute, redirect } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { $api, meQuery } from '../../api.ts';
import { PageHeader } from '../../components/page-header.tsx';
import { Button } from '../../components/ui/button.tsx';
import { CopyField } from '../../components/ui/copy.tsx';
import { Field } from '../../components/ui/field.tsx';
import { Panel } from '../../components/ui/panel.tsx';
import { fieldErrors, ProblemAlert, toProblem } from '../../components/ui/problem-alert.tsx';

const tenantsQuery = $api.queryOptions('get', '/api/v1/tenants');

export const Route = createFileRoute('/_app/operator')({
  beforeLoad: async ({ context }) => {
    const me = await context.queryClient.ensureQueryData(meQuery);
    if (!me.isOperator) throw redirect({ to: '/' });
  },
  loader: ({ context }) => context.queryClient.ensureQueryData(tenantsQuery),
  component: Operator,
});

function Operator() {
  const { data } = useSuspenseQuery(tenantsQuery);
  return (
    <div className="max-w-3xl">
      <PageHeader title="Operator" />
      <div className="grid gap-5">
        <CreateTenant />
        <Panel title={`Tenants (${data.items.length})`}>
          <ul aria-label="Tenants" className="-my-2 divide-y divide-line">
            {data.items.map((tenant) => (
              <li key={tenant.id} className="flex flex-wrap items-baseline justify-between gap-x-4 py-2.5">
                <span className="text-[15px] font-semibold">{tenant.name}</span>
                <span className="font-mono text-[13px] text-ink-3">{tenant.slug}</span>
              </li>
            ))}
          </ul>
        </Panel>
      </div>
    </div>
  );
}

/** Creates a tenant; a new owner account comes with a one-time password-reset link to hand over. */
function CreateTenant() {
  const queryClient = useQueryClient();
  const create = $api.useMutation('post', '/api/v1/tenants');
  const [problem, setProblem] = useState<Problem | null>(null);
  const [created, setCreated] = useState<{ name: string; owner: string | null; resetUrl: string | null } | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await createTenant(event.currentTarget);
  }

  async function createTenant(form: HTMLFormElement, allowUnverifiedOwner = false) {
    const data = new FormData(form);
    const text = (key: string) => String(data.get(key)).trim();
    setProblem(null);
    setCreated(null);
    try {
      const result = await create.mutateAsync({
        body: { allowUnverifiedOwner, name: text('name'), ...(text('slug') && { slug: text('slug') }), ...(text('ownerEmail') && { ownerEmail: text('ownerEmail') }) },
      });
      form.reset();
      setCreated({ name: result.tenant.name, owner: result.owner?.email ?? null, resetUrl: result.passwordResetUrl });
      await queryClient.invalidateQueries({ queryKey: tenantsQuery.queryKey });
    } catch (failure) {
      setProblem(toProblem(failure));
    }
  }

  const errors = fieldErrors(problem);
  return (
    <Panel title="New tenant" description="Give it an owner by email: an existing user joins as owner; a new one gets an account and a one-time link to set a password.">
      <form onSubmit={submit} className="grid gap-3">
        {problem && <ProblemAlert problem={problem} />}
        <div className="grid items-start gap-3 sm:grid-cols-2">
          <Field label="Name" name="name" required maxLength={100} error={errors.name} />
          <Field label="Slug" name="slug" hint="Optional; made from the name." pattern="[a-z0-9]+(-[a-z0-9]+)*" minLength={2} maxLength={64} error={errors.slug} />
        </div>
        <Field label="Owner email" name="ownerEmail" type="email" hint="Optional." error={errors.ownerEmail} />
        {problem?.detail === 'An unverified account holds that email' && (
          <Button disabled={create.isPending} onClick={(event) => {
            const form = event.currentTarget.form;
            if (form && window.confirm('Assign this unverified account as owner?')) {
              void createTenant(form, true);
            }
          }}>Assign anyway</Button>
        )}
        <div>
          <Button type="submit" variant="primary" disabled={create.isPending}>
            Create tenant
          </Button>
        </div>
      </form>
      {created && (
        <div role="status" className="mt-4 grid gap-3 rounded-lg bg-accent-soft px-3.5 py-3">
          <p className="text-sm text-accent-text">
            Created {created.name}
            {created.owner && `, owned by ${created.owner}`}.
          </p>
          {created.resetUrl && (
            <>
              <p className="text-sm text-ink-2">Send the owner this link to set their password. It is shown only now.</p>
              <CopyField label="Password link" value={created.resetUrl} />
            </>
          )}
        </div>
      )}
    </Panel>
  );
}
