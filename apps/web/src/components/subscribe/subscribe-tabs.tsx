/**
 * The Subscribe screen's per-client tabs, built from `GET /feeds/{id}/subscribe` and the secrets
 * held in memory. CalDAV tabs need the app password, ICS tabs the link token; when one is not held,
 * the tab offers to rotate it (the server never shows a secret twice).
 */
import type { ReactNode } from 'react';
import type { FeedSecrets } from '../../secrets.ts';
import { RotateCredential } from '../feeds/rotate-credential.tsx';
import { CopyField } from '../ui/copy.tsx';
import { QrButton, QrCode } from '../ui/qr-code.tsx';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs.tsx';
import { subscribeLinks, type FeedLink, type SubscribeInfo, type SubscribeLinks } from './links.ts';

const TABS = [
  { value: 'apple', label: 'Apple' },
  { value: 'google', label: 'Google Calendar' },
  { value: 'outlook', label: 'Outlook' },
  { value: 'android', label: 'Android' },
  { value: 'other', label: 'Thunderbird and others' },
  { value: 'ics', label: 'Any app (ICS)' },
] as const;

export type SubscribeTab = (typeof TABS)[number]['value'];

/** The tab for the device the page is open on: phones often open this screen to subscribe themselves. */
export function tabForDevice(userAgent: string): SubscribeTab {
  if (/iPhone|iPad|Macintosh/.test(userAgent)) return 'apple';
  if (/Android/.test(userAgent)) return 'android';
  return 'google';
}

type SubscribeTabsProps = {
  feedId: string;
  info: SubscribeInfo;
  secrets: FeedSecrets;
  defaultTab?: SubscribeTab;
  /** Rendered on the Google tab where the sink card goes (#21). */
  googleExtra?: ReactNode;
};

export function SubscribeTabs({ feedId, info, secrets, defaultTab = 'apple', googleExtra }: SubscribeTabsProps) {
  const links = secrets.icsToken ? subscribeLinks(info, secrets.icsToken) : null;
  const locked = <LinksLocked feedId={feedId} hasToken={info.ics.hasToken} />;
  return (
    <Tabs defaultValue={defaultTab}>
      <TabsList aria-label="Calendar app">
        {TABS.map((tab) => (
          <TabsTrigger key={tab.value} value={tab.value}>
            {tab.label}
          </TabsTrigger>
        ))}
      </TabsList>
      <TabsContent value="apple">
        <AppleTab feedId={feedId} info={info} password={secrets.caldavPassword} />
      </TabsContent>
      <TabsContent value="google">
        <div className="grid gap-4">
          {links ? <GoogleTab links={links} /> : locked}
          <Freshness>Google refreshes subscribed calendars every 6–24 hours, and you cannot refresh them by hand. Changes reach Google that much later.</Freshness>
          {googleExtra}
        </div>
      </TabsContent>
      <TabsContent value="outlook">
        <div className="grid gap-4">
          {links ? <OutlookTab links={links} /> : locked}
          <Freshness>Outlook refreshes subscribed calendars about every 3–6 hours, sometimes after more than a day.</Freshness>
        </div>
      </TabsContent>
      <TabsContent value="android">
        <AndroidTab feedId={feedId} info={info} password={secrets.caldavPassword} />
      </TabsContent>
      <TabsContent value="other">
        <div className="grid gap-4">
          <Lead>Thunderbird, Fantastical, BusyCal, Evolution and other CalDAV apps: add a CalDAV account with these details.</Lead>
          <CaldavDetails feedId={feedId} info={info} password={secrets.caldavPassword} />
        </div>
      </TabsContent>
      <TabsContent value="ics">{links ? <IcsTab links={links} /> : locked}</TabsContent>
    </Tabs>
  );
}

function AppleTab({ feedId, info, password }: { feedId: string; info: SubscribeInfo; password: string | undefined }) {
  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-center gap-3">
        <a
          href={info.appleProfileUrl}
          download
          className="inline-flex h-10 items-center rounded-[9px] bg-accent px-4 text-[15px] font-medium text-accent-ink shadow-xs hover:opacity-90"
        >
          Download profile
        </a>
        <span className="text-sm text-ink-3">Adds this feed as a read-only calendar account on iPhone, iPad or Mac.</span>
      </div>
      <Steps>
        <li>Open this page in Safari on the device and tap Download profile, then Allow.</li>
        <li>
          Open Settings and tap <b>Profile Downloaded</b> near the top (on a Mac: System Settings › Privacy &amp; Security › Profiles).
        </li>
        <li>Tap Install. iOS removes a downloaded profile after about 8 minutes, so install it soon.</li>
        <li>When the device asks for the account password, enter the CalDAV password below.</li>
      </Steps>
      <CaldavPassword feedId={feedId} password={password} />
      <details className="group rounded-lg border border-line px-4 py-3">
        <summary className="cursor-pointer text-[15px] font-medium">Set up CalDAV by hand instead</summary>
        <div className="mt-3 grid gap-3">
          <Lead>Settings › Calendar › Accounts › Add Account › Other › Add CalDAV Account, then enter:</Lead>
          <CaldavDetails feedId={feedId} info={info} password={password} withoutPassword />
        </div>
      </details>
      <Freshness>Apple devices check CalDAV on their fetch schedule ({info.freshness.caldav}).</Freshness>
    </div>
  );
}

function GoogleTab({ links }: { links: SubscribeLinks }) {
  return (
    <div className="grid gap-3">
      <Lead>Each link opens Google Calendar on the web and asks to add the calendar. Sign in to the Google account that should show it.</Lead>
      <ul className="grid gap-2">
        {[links.combined, ...links.publications].map((link) => (
          <li key={link.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line px-3.5 py-2.5">
            <span className="min-w-0 truncate text-[15px]">{link.name}</span>
            <ExternalLink href={link.google}>Add to Google Calendar</ExternalLink>
          </li>
        ))}
      </ul>
    </div>
  );
}

function OutlookTab({ links }: { links: SubscribeLinks }) {
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap gap-2">
        <ExternalLink href={links.outlookPersonal}>Add to Outlook.com</ExternalLink>
        <ExternalLink href={links.outlookWork}>Add to Outlook (work or school)</ExternalLink>
      </div>
      <Lead>
        If a button does not work, in Outlook choose Add calendar › Subscribe from web and paste the ICS link.
      </Lead>
      <CopyField label="ICS link" value={links.combined.https} />
    </div>
  );
}

function AndroidTab({ feedId, info, password }: { feedId: string; info: SubscribeInfo; password: string | undefined }) {
  return (
    <div className="grid gap-5">
      <Steps>
        <li>
          Install{' '}
          <a href="https://www.davx5.com/" target="_blank" rel="noreferrer" className="text-accent hover:underline">
            DAVx5
          </a>{' '}
          (Play Store or F-Droid).
        </li>
        <li>Add an account and choose Login with URL and user name.</li>
        <li>Enter the server URL (or scan the code), the username and the password below.</li>
        <li>Choose the calendars to sync; they appear in your phone’s calendar app.</li>
      </Steps>
      <div className="flex flex-wrap items-start gap-5">
        <div className="shrink-0 rounded-xl border border-line bg-white p-2">
          <QrCode value={info.caldav.wellKnown} label="QR code of the CalDAV server URL" size={160} />
        </div>
        <div className="grid min-w-0 flex-1 basis-64 gap-3">
          <CaldavDetails feedId={feedId} info={info} password={password} />
        </div>
      </div>
      <Freshness>DAVx5 syncs at the interval you choose (Android allows 15 minutes at the shortest).</Freshness>
    </div>
  );
}

function IcsTab({ links }: { links: SubscribeLinks }) {
  return (
    <div className="grid gap-4">
      <Lead>
        For apps that subscribe by URL. <span className="font-mono text-[13px]">webcal://</span> opens your calendar app directly; use{' '}
        <span className="font-mono text-[13px]">https://</span> where an app asks for a URL. Anyone with a link can read the calendar.
      </Lead>
      <ul className="grid gap-3">
        {[links.combined, ...links.publications].map((link) => (
          <IcsLinks key={link.id} link={link} />
        ))}
      </ul>
    </div>
  );
}

function IcsLinks({ link }: { link: FeedLink }) {
  return (
    <li className="grid gap-2.5 rounded-lg border border-line px-3.5 py-3">
      <h3 className="text-[15px] font-semibold">{link.name}</h3>
      <CopyField label={`${link.name}: webcal`} value={link.webcal} copyLabel={`Copy webcal link for ${link.name}`} actions={<QrButton value={link.webcal} title={link.name} />} />
      <CopyField label={`${link.name}: https`} value={link.https} copyLabel={`Copy https link for ${link.name}`} actions={<QrButton value={link.https} title={link.name} />} />
    </li>
  );
}

/** Server URL, username and the password (or a way to get one), for CalDAV setup; `withoutPassword` where it shows elsewhere. */
function CaldavDetails({ feedId, info, password, withoutPassword = false }: { feedId: string; info: SubscribeInfo; password: string | undefined; withoutPassword?: boolean }) {
  return (
    <div className="grid gap-3">
      <CopyField label="Server URL" value={info.caldav.serverUrl} />
      <CopyField label="Username" value={info.caldav.username} />
      {!withoutPassword && <CaldavPassword feedId={feedId} password={password} />}
    </div>
  );
}

/** The CalDAV password right after a rotation, else a way to get one. */
function CaldavPassword({ feedId, password }: { feedId: string; password: string | undefined }) {
  if (password) return <CopyField label="Password" value={password} copyLabel="Copy CalDAV password" />;
  return (
    <div className="grid gap-2 rounded-lg bg-surface-2 px-3.5 py-3">
      <p className="text-sm text-ink-2">
        <span className="font-semibold text-ink">Password.</span> Supercal shows the CalDAV password only once. If you do not have it, rotate it to get a new
        one; devices using the old password must be updated.
      </p>
      <div>
        <RotateCredential feedId={feedId} kind="caldav" reveal={false} label="New password" size="sm" />
      </div>
    </div>
  );
}

/** Shown on link tabs until the ICS token is in memory. */
function LinksLocked({ feedId, hasToken }: { feedId: string; hasToken: boolean }) {
  return (
    <div className="grid gap-2 rounded-lg bg-surface-2 px-3.5 py-3">
      <p className="text-sm text-ink-2">
        Links contain a secret that Supercal shows only once.{' '}
        {hasToken ? 'Show links rotates the link; old links stop working.' : 'Create the feed’s link to see them.'}
      </p>
      <div>
        <RotateCredential
          feedId={feedId}
          kind="ics"
          reveal={false}
          variant="primary"
          label={hasToken ? 'Show links' : 'Create links'}
          description={
            hasToken
              ? 'Showing links rotates the link: apps subscribed with the old link stop updating until you subscribe again.'
              : 'Creates the feed’s secret ICS link.'
          }
        />
      </div>
    </div>
  );
}

function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex h-9 items-center rounded-[9px] border border-line bg-surface px-4 text-[15px] font-medium shadow-xs hover:bg-surface-2"
    >
      {children}
    </a>
  );
}

const Lead = ({ children }: { children: ReactNode }) => <p className="text-[15px] text-ink-2">{children}</p>;

const Steps = ({ children }: { children: ReactNode }) => (
  <ol className="grid list-decimal gap-1.5 pl-5 text-[15px] marker:text-ink-3">{children}</ol>
);

/** How quickly the client picks up changes (spikes/feed/FINDINGS.md Q8): honest, not promised. */
const Freshness = ({ children }: { children: ReactNode }) => <p className="text-[13px] text-ink-3">{children}</p>;
