import type { components } from '@supercal/api-client';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { authClient } from '../../auth.ts';
import { useTheme, type ThemePreference } from '../../theme.ts';
import { Icon } from '../ui/icon.tsx';
import { Menu, MenuContent, MenuItem, MenuLabel, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuTrigger } from '../ui/menu.tsx';

type Me = components['schemas']['Me'];

const THEMES: { value: ThemePreference; label: string }[] = [
  { value: 'system', label: 'Match system' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

const isThemePreference = (value: string): value is ThemePreference => THEMES.some((theme) => theme.value === value);

/** The signed-in user: theme choice and sign-out. */
export function UserMenu({ me }: { me: Me }) {
  const { preference, setPreference } = useTheme();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  async function signOut() {
    await authClient.signOut();
    queryClient.clear();
    await navigate({ to: '/sign-in' });
  }

  return (
    <Menu>
      <MenuTrigger className="flex w-full items-center gap-3 rounded-[9px] px-1.5 py-1.5 text-left text-sm hover:bg-surface-2 data-[state=open]:bg-surface-2">
        <span aria-hidden className="grid size-8 shrink-0 place-items-center rounded-full bg-accent-soft text-base text-accent-text">
          {me.user.name.slice(0, 1).toUpperCase()}
        </span>
        <span className="min-w-0 flex-1 truncate">{me.user.name}</span>
        <Icon name="chevron" className="size-4 text-ink-2" />
      </MenuTrigger>
      <MenuContent align="start" side="top" className="w-60">
        <p className="truncate px-2.5 pt-1.5 pb-1 text-xs text-ink-3">{me.user.email}</p>
        <MenuSeparator />
        <MenuLabel>Theme</MenuLabel>
        <MenuRadioGroup value={preference} onValueChange={(value) => isThemePreference(value) && setPreference(value)}>
          {THEMES.map((theme) => (
            <MenuRadioItem key={theme.value} value={theme.value}>
              {theme.label}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
        <MenuSeparator />
        <MenuItem onSelect={() => void signOut()}>Sign out</MenuItem>
      </MenuContent>
    </Menu>
  );
}
