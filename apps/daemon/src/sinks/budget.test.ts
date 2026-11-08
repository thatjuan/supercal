import { expect, test } from 'bun:test';
import { createWriteBudget } from './budget.ts';

test('the budget limits writes per second and per minute for each user, and says how long to wait', () => {
  let now = 0;
  const perSecond = createWriteBudget({ now: () => now });
  expect(Array.from({ length: 6 }, () => perSecond.take('sub-1'))).toEqual([0, 0, 0, 0, 0, 1000]);
  expect(perSecond.take('sub-2')).toBe(0);
  now = 400;
  expect(perSecond.take('sub-1')).toBe(600);

  const perMinute = createWriteBudget({ perSecond: Infinity, perMinute: 3, now: () => now });
  expect(Array.from({ length: 4 }, () => perMinute.take('sub-1'))).toEqual([0, 0, 0, 60_000]);
  now += 60_000;
  expect(perMinute.take('sub-1')).toBe(0);
});
