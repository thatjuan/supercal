import type { components } from '@supercal/api-client';
import { Link, useRouterState, type LinkProps } from '@tanstack/react-router';
import { useEffect, useRef } from 'react';
import type { LiveStatus } from '../../live.ts';
import { Icon, type IconName } from '../ui/icon.tsx';
import { LiveIndicator } from '../ui/live-indicator.tsx';
import { Wordmark } from '../wordmark.tsx';
import { TenantSwitcher } from './tenant-switcher.tsx';
import { UserMenu } from './user-menu.tsx';

type Me = components['schemas']['Me'];
type NavItem = { label: string; icon: IconName; to?: LinkProps['to']; adminOnly?: true; operatorOnly?: true };

/**
 * Navigation in the order a user meets the screens (docs/product.md). Entries without `to` are
 * screens later issues add; each turns into a link when its route exists. Admin is for tenant
 * owners and admins only, Operator for the install's operator.
 */
const NAV: readonly NavItem[] = [
  { label: 'Overview', icon: 'home', to: '/' },
  { label: 'Accounts', icon: 'users', to: '/accounts' },
  { label: 'Calendars', icon: 'calendar', to: '/calendars' },
  { label: 'Hosted', icon: 'calendar-plus', to: '/hosted' },
  { label: 'Preview', icon: 'eye', to: '/preview' },
  { label: 'Subscribe', icon: 'link', to: '/feeds' },
  { label: 'Settings', icon: 'gear', to: '/settings' },
  { label: 'Admin', icon: 'shield', to: '/admin', adminOnly: true },
  { label: 'Operator', icon: 'layers', to: '/operator', operatorOnly: true },
];

const itemClass = 'flex h-10 items-center gap-4 rounded-[9px] px-3 text-base max-md:gap-2 max-md:whitespace-nowrap';

function NavLink({ item }: { item: NavItem }) {
  const content = (
    <>
      <Icon name={item.icon} className="size-[22px] text-ink-2" />
      {item.label}
    </>
  );
  if (!item.to) {
    return (
      <span aria-disabled className={`${itemClass} cursor-default text-ink-3 [&_svg]:text-ink-3`}>
        {content}
      </span>
    );
  }
  return (
    <Link
      to={item.to}
      className={`${itemClass} text-ink-2 hover:bg-surface-2 hover:text-ink`}
      activeProps={{ className: 'bg-accent-soft font-semibold text-accent-text! hover:bg-accent-soft! [&_svg]:text-accent!' }}
      activeOptions={{ exact: item.to === '/' }}
    >
      {content}
    </Link>
  );
}

/** The shell's left column: wordmark, tenant switcher, live status, navigation, and the user at the foot. Below `md` it is a top bar whose navigation scrolls sideways. */
export function Sidebar({ me, live }: { me: Me; live: LiveStatus }) {
  const nav = useRef<HTMLElement>(null);
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  // On phones the navigation is a sideways strip: keep the current screen's entry in view.
  useEffect(() => {
    nav.current?.querySelector('[data-status="active"]')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [pathname]);
  const items = NAV.filter((item) => (!item.adminOnly || me.role !== 'member') && (!item.operatorOnly || me.isOperator));
  return (
    <aside className="flex w-52 shrink-0 flex-col border-r border-line px-3.5 pt-4 pb-3 max-md:w-full max-md:flex-row max-md:flex-wrap max-md:items-center max-md:gap-2 max-md:border-r-0 max-md:border-b max-md:px-3 max-md:py-2 max-md:[&>button]:max-w-32">
      <Wordmark className="mx-2.5 mt-1 mb-4 max-md:order-first max-md:mx-1 max-md:my-0 max-md:text-[22px]" />
      <TenantSwitcher me={me} />
      <LiveIndicator status={live} className="mx-1.5 my-4 max-md:order-first max-md:my-0 max-md:mr-auto" />
      <nav ref={nav} aria-label="Main" className="max-md:order-last max-md:-mx-3 max-md:w-[calc(100%+1.5rem)] max-md:overflow-x-auto max-md:px-3 max-md:[scrollbar-width:none]">
        <ul className="grid gap-1.5 max-md:flex max-md:gap-1">
          {items.map((item) => (
            <li key={item.label}>
              <NavLink item={item} />
            </li>
          ))}
        </ul>
      </nav>
      <div className="mt-auto pt-3 max-md:mt-0 max-md:pt-0 max-md:[&_button>span:nth-child(2)]:hidden max-md:[&_button>svg]:hidden">
        <UserMenu me={me} />
      </div>
    </aside>
  );
}
