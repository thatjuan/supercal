import type { components } from '@supercal/api-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Sidebar } from './sidebar.tsx';

type Me = components['schemas']['Me'];

const tenant = { id: 't1', name: 'Acme Lab', slug: 'acme-lab' };
const meAs = (role: Me['role'], isOperator = false): Me => ({
  user: { id: 'u1', name: 'Ada Lovelace', email: 'ada@example.invalid' },
  tenant,
  role,
  isOperator,
  via: 'session',
  tenants: [{ ...tenant, role }],
});

async function navFor(me: Me) {
  const rootRoute = createRootRoute({ component: () => <Sidebar me={me} live="live" /> });
  const router = createRouter({ routeTree: rootRoute, history: createMemoryHistory({ initialEntries: ['/'] }) });
  render(
    <QueryClientProvider client={new QueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  const nav = await screen.findByRole('navigation', { name: 'Main' });
  return within(nav)
    .getAllByRole('link')
    .map((link) => link.textContent);
}

beforeEach(() => {
  // useTheme (the user menu) reads prefers-color-scheme, which jsdom lacks.
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }));
  // The router scrolls to the top on navigation; jsdom does not implement it.
  vi.stubGlobal('scrollTo', () => {});
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test.each([
  ['member', meAs('member'), ['Overview', 'Subscribe', 'Settings']],
  ['admin', meAs('admin'), ['Overview', 'Subscribe', 'Settings', 'Admin']],
  ['owner', meAs('owner'), ['Overview', 'Subscribe', 'Settings', 'Admin']],
  ['operator (a member of this tenant)', meAs('member', true), ['Overview', 'Subscribe', 'Settings', 'Operator']],
] as const)('%s sees %j', async (_who, me, expected) => {
  const links = await navFor(me);
  expect(links.filter((label) => label !== null && expected.includes(label as never))).toEqual(expected);
  expect(links.includes('Admin')).toBe(expected.includes('Admin' as never));
  expect(links.includes('Operator')).toBe(expected.includes('Operator' as never));
});
