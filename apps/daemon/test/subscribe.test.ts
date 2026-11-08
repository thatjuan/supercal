/** The Apple profile and the one-click links, without a database. */
import type { FeedId } from '@supercal/db';
import { describe, expect, test } from 'bun:test';
import { caldavMobileconfig, subscribeLinks } from '../src/api/subscribe.ts';

const id = 'feed_01abc' as FeedId;

describe('mobileconfig', () => {
  const profile = caldavMobileconfig({ publicUrl: 'https://cal.example.com', feed: { id, name: 'Juan & co <cal>', caldavUsername: 'juan-x1y2z3' } });

  test('names the CalDAV account without a password, with UUIDs stable per feed', () => {
    expect(profile).not.toContain('CalDAVPassword');
    expect(profile).toContain('<key>CalDAVPrincipalURL</key><string>https://cal.example.com/dav/juan-x1y2z3/</string>');
    expect(profile).toContain('<key>CalDAVPort</key><integer>443</integer>');
    expect(profile).toContain('Juan &#38; co &#60;cal&#62;');
    const again = caldavMobileconfig({ publicUrl: 'https://cal.example.com', feed: { id, name: 'Renamed', caldavUsername: 'juan-x1y2z3' } });
    const uuids = (text: string) => [...text.matchAll(/<key>PayloadUUID<\/key><string>([^<]+)/g)].map((m) => m[1]);
    expect(uuids(again)).toEqual(uuids(profile));
  });

  test.skipIf(process.platform !== 'darwin')('passes plutil -lint', async () => {
    const path = `${process.env.TMPDIR ?? '/tmp'}/supercal-${crypto.randomUUID()}.mobileconfig`;
    await Bun.write(path, profile);
    const lint = Bun.spawnSync(['plutil', '-lint', path]);
    await Bun.file(path).delete();
    expect(lint.stdout.toString()).toEndWith(': OK\n');
  });
});

test('the Google link percent-encodes the webcal URL and keeps a token with - and _ intact', () => {
  const token = 'Ab-_9z-_Q';
  const { google, outlookPersonal } = subscribeLinks('https://cal.example.com', 'My feed', token);
  expect(google).toBe(`https://calendar.google.com/calendar/render?cid=webcal%3A%2F%2Fcal.example.com%2Fics%2F${token}%2Fall.ics`);
  expect(new URL(google).searchParams.get('cid')).toBe(`webcal://cal.example.com/ics/${token}/all.ics`);
  expect(new URL(outlookPersonal).searchParams.get('url')).toBe(`https://cal.example.com/ics/${token}/all.ics`);
  expect(new URL(outlookPersonal).searchParams.get('name')).toBe('My feed');
});
