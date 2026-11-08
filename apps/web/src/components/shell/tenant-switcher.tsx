import type { components } from '@supercal/api-client';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { authClient } from '../../auth.ts';
import { Icon } from '../ui/icon.tsx';
import { Menu, MenuContent, MenuLabel, MenuRadioGroup, MenuRadioItem, MenuTrigger } from '../ui/menu.tsx';

type Me = components['schemas']['Me'];

const ROLE_LABEL = { owner: 'Owner', admin: 'Admin', member: 'Member' } as const;

/** The active tenant and a menu of the user's others; choosing one makes it the session's active organization. */
export function TenantSwitcher({ me }: { me: Me }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  async function switchTo(organizationId: string) {
    if (organizationId === me.tenant.id) return;
    const { error } = await authClient.organization.setActive({ organizationId });
    if (error) return;
    // Every query is tenant-scoped; the live stream reopens once `/me` names the new tenant.
    await queryClient.invalidateQueries();
    await navigate({ to: '/' });
  }

  return (
    <Menu>
      <MenuTrigger className="mx-1 flex h-10 items-center gap-2 rounded-[9px] border border-line-strong bg-surface px-3 text-left text-sm shadow-xs hover:bg-surface-2 data-[state=open]:bg-surface-2">
        <Icon name="layers" className="text-ink-2" />
        <span className="min-w-0 flex-1 truncate">{me.tenant.name}</span>
        <Icon name="chevron" className="size-3.5 text-ink-2" />
        <span className="sr-only">Switch tenant</span>
      </MenuTrigger>
      <MenuContent align="start" className="w-60">
        <MenuLabel>Tenants</MenuLabel>
        <MenuRadioGroup value={me.tenant.id} onValueChange={(id) => void switchTo(id)}>
          {me.tenants.map((tenant) => (
            <MenuRadioItem key={tenant.id} value={tenant.id}>
              <span className="min-w-0 flex-1 truncate">{tenant.name}</span>
              <span className="text-xs text-ink-3">{ROLE_LABEL[tenant.role]}</span>
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuContent>
    </Menu>
  );
}
