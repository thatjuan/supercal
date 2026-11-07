import { expect, test } from 'bun:test';
import { newId, parseId, type FeedId } from './ids.ts';

test('newId produces TypeIDs that parseId accepts', () => {
  const id = newId('feed');
  expect(id).toMatch(/^feed_[0-7][0-9a-hjkmnp-tv-z]{25}$/);
  expect(parseId('feed', id)).toBe(id);
});

test.each([
  ['wrong prefix', 'acc_01h455vb4pex5vsknk084sn02q'],
  ['no suffix', 'feed_'],
  ['out of range', 'feed_81h455vb4pex5vsknk084sn02q'],
  ['excluded letter', 'feed_01h455vb4pex5vsknk084sn02u'],
  ['extra part', 'feed_01h455vb4pex5vsknk084sn02q_x'],
])('parseId rejects %s', (_case, raw) => {
  expect(parseId('feed', raw)).toBeNull();
});

test('an AccountId is not a FeedId', () => {
  const wantsFeed = (id: FeedId) => id;
  // @ts-expect-error ids of different entities must not mix
  wantsFeed(newId('acc'));
  // @ts-expect-error a plain string is not an id either
  wantsFeed('feed_01h455vb4pex5vsknk084sn02q');
});
