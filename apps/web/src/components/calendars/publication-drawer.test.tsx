import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { stubMatchMedia } from '../../test/match-media.ts';
import type { Publication } from './data.ts';
import { PublicationDrawer, PublicationForm } from './publication-drawer.tsx';
import { EPOCH_NOTE } from './settings.ts';
import { CONFLICT_MESSAGE } from './use-publication-editor.ts';

const api = vi.hoisted(() => ({ GET: vi.fn(), PATCH: vi.fn() }));
vi.mock(import('../../api.ts'), async (original) => {
  const actual = await original();
  return { ...actual, client: { ...actual.client, GET: api.GET, PATCH: api.PATCH } };
});

const work: Publication = {
  id: 'pub_1',
  feedId: 'feed_1',
  slug: 'work',
  name: 'Work',
  color: '#2f80ed',
  privacy: 'full',
  filters: { hideDeclined: false, hideCancelled: false, hideAllDay: false },
  keepAlarms: false,
  enabled: true,
  sortOrder: 0,
  status: 'ok',
  statusDetail: null,
  kind: 'passthrough',
  sourceCalendarId: 'cal_1',
};

beforeEach(stubMatchMedia);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

const note = () => screen.queryByRole('note');

describe('PublicationForm', () => {
  const renderForm = () => render(<PublicationForm publication={work} fallbackColor={null} onSave={() => {}} onCancel={() => {}} pending={false} conflict={false} problem={null} />);

  test('name and colour changes save without the re-download note', () => {
    renderForm();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Job' } });
    fireEvent.click(screen.getByRole('button', { name: '#27ae60' }));
    expect(note()).toBeNull();
  });

  const click = (role: 'radio' | 'checkbox', name: RegExp | string) => () => fireEvent.click(screen.getByRole(role, { name }));

  test.each([
    ['privacy', click('radio', /Busy only/), click('radio', /^Full/)],
    ['a filter', click('checkbox', 'Hide declined events'), click('checkbox', 'Hide declined events')],
    ['reminders', click('checkbox', /Keep reminders/), click('checkbox', /Keep reminders/)],
  ])('changing %s shows the re-download note, and undoing it hides it', (_, change, undo) => {
    renderForm();
    change();
    expect(note()?.textContent).toBe(EPOCH_NOTE);
    undo();
    expect(note()).toBeNull();
  });
});

describe('PublicationDrawer', () => {
  const loaded = (publication: Publication, etag: string) => ({ data: publication, error: undefined, response: new Response(null, { headers: { ETag: etag } }) });

  test('a 412 reloads the publication, explains, and the next save uses the new ETag', async () => {
    api.GET.mockResolvedValueOnce(loaded(work, 'W/"v1"')).mockResolvedValueOnce(loaded({ ...work, name: 'Work (theirs)' }, 'W/"v2"'));
    api.PATCH.mockResolvedValueOnce({ data: undefined, error: { type: 'about:blank', title: 'Precondition Failed', status: 412 } }).mockResolvedValueOnce({
      data: { ...work, name: 'Mine' },
      error: undefined,
    });
    api.GET.mockResolvedValue(loaded({ ...work, name: 'Mine' }, 'W/"v3"'));
    const onClose = vi.fn();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <PublicationDrawer publicationId="pub_1" fallbackColor={null} onClose={onClose} />
      </QueryClientProvider>,
    );

    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'Mine' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect((await screen.findByRole('alert')).textContent).toBe(CONFLICT_MESSAGE);
    await waitFor(() => expect(screen.getByLabelText<HTMLInputElement>('Name').value).toBe('Work (theirs)'));
    expect(api.PATCH).toHaveBeenLastCalledWith('/api/v1/publications/{id}', { params: { path: { id: 'pub_1' }, header: { 'if-match': 'W/"v1"' } }, body: { name: 'Mine' } });
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Mine' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(api.PATCH).toHaveBeenLastCalledWith('/api/v1/publications/{id}', { params: { path: { id: 'pub_1' }, header: { 'if-match': 'W/"v2"' } }, body: { name: 'Mine' } });
  });
});
