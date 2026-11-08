/**
 * The credential forms for iCloud, CalDAV and ICS accounts. Each validates in the browser, then
 * calls `onSubmit` with its values (shaped like the API's `NewAccount` variant without `provider`)
 * and shows a rejection inline through `connectError`. With `reconnect`, only the secret parts are
 * asked for: the server and name stay as connected.
 *
 *   <CaldavForm onSubmit={(values) => connect.mutateAsync({ body: { provider: 'caldav', ...values } })} />
 */
import type { components } from '@supercal/api-client';
import { useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Button } from '../ui/button.tsx';
import { Field } from '../ui/field.tsx';
import { connectError, type ConnectError } from './connect-problem.ts';
import type { FormProvider } from './providers.tsx';

type Schemas = components['schemas'];
export type FormValues = {
  ics: Omit<Schemas['NewIcsAccount'], 'provider'>;
  caldav: Omit<Schemas['NewCaldavAccount'], 'provider'>;
  icloud: Omit<Schemas['NewIcloudAccount'], 'provider'>;
};

export type FormProps<P extends FormProvider> = {
  onSubmit: (values: FormValues[P]) => Promise<unknown>;
  reconnect?: boolean;
  onCancel?: () => void;
};

type Errors = Partial<Record<string, string>>;

/** Submission state shared by the forms: client-side errors first, then the server's answer. */
function useConnectForm<P extends FormProvider>(provider: P, onSubmit: FormProps<P>['onSubmit']) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ConnectError | null>(null);
  const submit = async (event: FormEvent, values: FormValues[P], errors: Errors) => {
    event.preventDefault();
    if (Object.values(errors).some(Boolean)) return setError({ message: null, fields: errors });
    setPending(true);
    setError(null);
    try {
      await onSubmit(values);
    } catch (thrown) {
      setError(connectError(thrown, provider));
    } finally {
      setPending(false);
    }
  };
  return { pending, error, fields: error?.fields ?? {}, submit };
}

/** `{ displayName }` when one was typed, else nothing (the API then names the account). */
const named = (value: string) => (value.trim() ? { displayName: value.trim() } : {});
const required = (value: string, label: string) => (value.trim() ? undefined : `Enter ${label}`);

/** The form's footer: the inline problem, then Cancel and the submit button. */
function Footer({ error, pending, label, onCancel }: { error: ConnectError | null; pending: boolean; label: string; onCancel?: (() => void) | undefined }) {
  return (
    <>
      {error?.message && (
        <p role="alert" className="rounded-lg border border-danger/30 bg-danger-soft px-3.5 py-2.5 text-sm text-danger">
          {error.message}
        </p>
      )}
      <div className="mt-1 flex justify-end gap-2">
        {onCancel && <Button onClick={onCancel}>Cancel</Button>}
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? 'Checking…' : label}
        </Button>
      </div>
    </>
  );
}

function Form({ onSubmit, children }: { onSubmit: (event: FormEvent) => void; children: ReactNode }) {
  return (
    <form noValidate onSubmit={onSubmit} className="grid gap-4">
      {children}
    </form>
  );
}

const APP_PASSWORDS_URL = 'https://support.apple.com/en-us/102654';

export function IcloudForm({ onSubmit, reconnect, onCancel }: FormProps<'icloud'>) {
  const [appleId, setAppleId] = useState('');
  const [password, setPassword] = useState('');
  const form = useConnectForm('icloud', onSubmit);
  const errors = () => ({ appleId: required(appleId, 'your Apple ID'), appSpecificPassword: required(password, 'an app-specific password') });
  return (
    <Form onSubmit={(event) => void form.submit(event, { appleId: appleId.trim(), appSpecificPassword: password.trim() }, errors())}>
      <p className="text-sm text-ink-2">
        Apple does not let other apps use your Apple ID password, so iCloud needs an app-specific password that you can revoke at any time.{' '}
        <a href={APP_PASSWORDS_URL} target="_blank" rel="noreferrer" className="text-accent-text underline underline-offset-2">
          How to create one
        </a>
      </p>
      <Field label="Apple ID" type="email" autoComplete="username" value={appleId} onChange={(e) => setAppleId(e.target.value)} error={form.fields.appleId} />
      <Field
        label="App-specific password"
        type="password"
        autoComplete="off"
        placeholder="xxxx-xxxx-xxxx-xxxx"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        error={form.fields.appSpecificPassword}
      />
      <Footer error={form.error} pending={form.pending} label={reconnect ? 'Reconnect' : 'Connect iCloud'} onCancel={onCancel} />
    </Form>
  );
}

/** Buttons that fill in a provider's CalDAV URL. Nextcloud's selects the `<host>` part for typing over. */
export const CALDAV_PRESETS = [
  { label: 'Fastmail', url: 'https://caldav.fastmail.com/' },
  { label: 'Nextcloud', url: 'https://<host>/remote.php/dav/' },
  { label: 'Yahoo', url: 'https://caldav.calendar.yahoo.com/' },
  { label: 'Zoho (US)', url: 'https://calendar.zoho.com/' },
  { label: 'Zoho (EU)', url: 'https://calendar.zoho.eu/' },
  { label: 'Zoho (IN)', url: 'https://calendar.zoho.in/' },
  { label: 'Zoho (AU)', url: 'https://calendar.zoho.com.au/' },
] as const;

const HOST_PLACEHOLDER = '<host>';

function serverUrlError(value: string): string | undefined {
  if (!value.trim()) return 'Enter the server URL';
  if (value.includes(HOST_PLACEHOLDER)) return 'Replace <host> with your server’s address';
  const url = URL.parse(value.trim());
  return url && (url.protocol === 'https:' || url.protocol === 'http:') ? undefined : 'Enter a URL starting with https://';
}

export function CaldavForm({ onSubmit, reconnect, onCancel }: FormProps<'caldav'>) {
  const [serverUrl, setServerUrl] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const urlInput = useRef<HTMLInputElement>(null);
  const form = useConnectForm('caldav', onSubmit);

  const preset = (url: string) => {
    setServerUrl(url);
    const input = urlInput.current;
    if (!input) return;
    input.focus();
    const host = url.indexOf(HOST_PLACEHOLDER);
    // After React writes the value, select `<host>` (or move to the end) so typing replaces it.
    requestAnimationFrame(() => (host >= 0 ? input.setSelectionRange(host, host + HOST_PLACEHOLDER.length) : input.setSelectionRange(url.length, url.length)));
  };

  const errors = () => ({
    serverUrl: reconnect ? undefined : serverUrlError(serverUrl),
    username: required(username, 'your username'),
    password: required(password, 'your password'),
  });
  const values = { serverUrl: serverUrl.trim(), username: username.trim(), password, ...named(displayName) };

  return (
    <Form onSubmit={(event) => void form.submit(event, values, errors())}>
      {!reconnect && (
        <>
          <div className="grid gap-1.5">
            <p id="caldav-presets" className="text-sm font-semibold text-ink">
              Common servers
            </p>
            <div role="group" aria-labelledby="caldav-presets" className="flex flex-wrap gap-1.5">
              {CALDAV_PRESETS.map((item) => (
                <Button key={item.label} size="sm" onClick={() => preset(item.url)}>
                  {item.label}
                </Button>
              ))}
            </div>
          </div>
          <Field
            ref={urlInput}
            label="Server URL"
            type="url"
            inputMode="url"
            placeholder="https://caldav.example.com/"
            value={serverUrl}
            onChange={(e) => setServerUrl(e.target.value)}
            error={form.fields.serverUrl}
          />
        </>
      )}
      <Field label="Username" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} error={form.fields.username} />
      <Field
        label="Password"
        type="password"
        autoComplete="current-password"
        hint="Use an app password if your provider offers one. It is stored encrypted."
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        error={form.fields.password}
      />
      {!reconnect && <Field label="Name (optional)" placeholder="username on server" value={displayName} onChange={(e) => setDisplayName(e.target.value)} error={form.fields.displayName} />}
      <Footer error={form.error} pending={form.pending} label={reconnect ? 'Reconnect' : 'Connect'} onCancel={onCancel} />
    </Form>
  );
}

function icsUrlError(value: string): string | undefined {
  if (!value.trim()) return 'Enter the calendar link';
  const url = URL.parse(value.trim());
  return url && ['https:', 'http:', 'webcal:'].includes(url.protocol) ? undefined : 'Enter a link starting with https:// or webcal://';
}

export function IcsForm({ onSubmit, reconnect, onCancel }: FormProps<'ics'>) {
  const [url, setUrl] = useState('');
  const [displayName, setDisplayName] = useState('');
  const form = useConnectForm('ics', onSubmit);
  return (
    <Form onSubmit={(event) => void form.submit(event, { url: url.trim(), ...named(displayName) }, { url: icsUrlError(url) })}>
      <Field
        label="Calendar link"
        type="url"
        inputMode="url"
        placeholder="https://… or webcal://…"
        hint="The link is stored encrypted. Some providers update their links slowly (Proton: up to 8 hours)."
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        error={form.fields.url}
      />
      {!reconnect && <Field label="Name (optional)" value={displayName} onChange={(e) => setDisplayName(e.target.value)} error={form.fields.displayName} />}
      <Footer error={form.error} pending={form.pending} label={reconnect ? 'Replace link' : 'Connect'} onCancel={onCancel} />
    </Form>
  );
}
