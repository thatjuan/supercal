/** Tenant admin (docs/product.md screen 9): members and invitations, the audit log, the tenant. Admins and owners only. */
import { useQuery, useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute, redirect } from '@tanstack/react-router';
import { useMemo } from 'react';
import { meQuery } from '../../api.ts';
import { AuditLog } from '../../components/admin/audit-log.tsx';
import { Members, organizationQuery } from '../../components/admin/members.tsx';
import { TenantSettings } from '../../components/admin/tenant.tsx';
import { PageHeader } from '../../components/page-header.tsx';

export const Route = createFileRoute('/_app/admin')({
  beforeLoad: async ({ context }) => {
    const me = await context.queryClient.ensureQueryData(meQuery);
    if (me.role === 'member') throw redirect({ to: '/' });
  },
  component: Admin,
});

function Admin() {
  const { data: me } = useSuspenseQuery(meQuery);
  const organization = useQuery(organizationQuery(me.tenant.id));
  const names = useMemo(() => new Map(organization.data?.members.map((member) => [member.userId, member.user.name])), [organization.data]);
  return (
    <div className="max-w-3xl">
      <PageHeader title="Admin" />
      <div className="grid gap-5">
        <Members tenantId={me.tenant.id} myRole={me.role} myUserId={me.user.id} />
        <AuditLog names={names} />
        <TenantSettings tenant={me.tenant} editable={me.role === 'owner'} />
      </div>
    </div>
  );
}
