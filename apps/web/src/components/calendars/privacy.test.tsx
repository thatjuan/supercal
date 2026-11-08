import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { stubMatchMedia } from '../../test/match-media.ts';
import { PrivacyPicker } from './privacy.tsx';

beforeEach(stubMatchMedia);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test('each privacy level explains itself and previews the example event as it would publish', () => {
  render(<PrivacyPicker value="full" onChange={() => {}} color="#2f80ed" />);

  expect(screen.getByRole<HTMLInputElement>('radio', { name: /Full.*All event details/ }).checked).toBe(true);
  screen.getByRole('radio', { name: /Title only.*title and time, no other details/ });
  screen.getByRole('radio', { name: /Busy only.*Only time blocks/ });

  const full = within(screen.getByTestId('privacy-example-full'));
  full.getByText('Design review');
  full.getByText(/Room 4B/);

  const titleOnly = within(screen.getByTestId('privacy-example-title-only'));
  titleOnly.getByText('Design review');
  expect(titleOnly.queryByText(/Room 4B/)).toBeNull();

  const busy = within(screen.getByTestId('privacy-example-busy-only'));
  busy.getByText('Busy');
  expect(busy.queryByText('Design review')).toBeNull();
  expect(busy.queryByText(/Room 4B/)).toBeNull();
});
