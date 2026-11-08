/**
 * Rotating a feed credential: a confirm dialog, the rotation, then (unless `reveal` is off) a
 * one-time reveal. The new secret also goes to the in-memory store (secrets.ts), so the Subscribe
 * screen can build links and show the password without asking again.
 */
import type { Problem } from '@supercal/api-client';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { $api } from '../../api.ts';
import { rememberFeedSecrets } from '../../secrets.ts';
import { Button, type ButtonProps } from '../ui/button.tsx';
import { ConfirmDialog } from '../ui/confirm-dialog.tsx';
import { toProblem } from '../ui/problem-alert.tsx';
import { SecretReveal, type Secret } from './secret-reveal.tsx';

export type CredentialKind = 'ics' | 'caldav';

const COPY = {
  ics: {
    title: 'Rotate the ICS link?',
    description: 'You get a new secret link. The old link stops working, so apps subscribed with it must be updated.',
    confirm: 'Rotate link',
    revealTitle: 'New ICS link',
    warning: 'The old link no longer works. Update every app and device that subscribed with it.',
  },
  caldav: {
    title: 'Rotate the CalDAV password?',
    description: 'You get a new app password. Devices using the old one stop syncing until you enter the new one.',
    confirm: 'Rotate password',
    revealTitle: 'New CalDAV password',
    warning: 'The old password no longer works. Enter the new one on every device that syncs this feed.',
  },
} as const;

type RotateCredentialProps = {
  feedId: string;
  kind: CredentialKind;
  label?: string;
  /** Replaces the confirm dialog's description (the Subscribe screen explains "Show links" this way). */
  description?: string;
  /** Show the one-time reveal dialog; off where the screen itself shows the new secret. */
  reveal?: boolean;
} & Pick<ButtonProps, 'variant' | 'size' | 'className'>;

export function RotateCredential({ feedId, kind, label, description, reveal = true, ...button }: RotateCredentialProps) {
  const copy = COPY[kind];
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<Problem | null>(null);
  const [revealed, setRevealed] = useState<readonly Secret[] | null>(null);
  const rotateIcs = $api.useMutation('post', '/api/v1/feeds/{id}/credentials/ics/rotate');
  const rotateCaldav = $api.useMutation('post', '/api/v1/feeds/{id}/credentials/caldav/rotate');

  async function rotate() {
    setError(null);
    const params = { params: { path: { id: feedId } } };
    try {
      if (kind === 'ics') {
        const { token, urls } = await rotateIcs.mutateAsync(params);
        rememberFeedSecrets(feedId, { icsToken: token });
        setRevealed([{ label: 'Combined feed (https)', value: urls.combined }]);
      } else {
        const { username, password } = await rotateCaldav.mutateAsync(params);
        rememberFeedSecrets(feedId, { caldavPassword: password });
        setRevealed([
          { label: 'Username', value: username },
          { label: 'Password', value: password },
        ]);
      }
      // `hasToken` on the Subscribe info changes after the first issue.
      await queryClient.invalidateQueries({ queryKey: ['get', '/api/v1/feeds/{id}/subscribe'] });
    } catch (failure) {
      setError(toProblem(failure));
      throw failure;
    }
  }

  return (
    <>
      <Button {...button} onClick={() => setConfirming(true)}>
        {label ?? copy.confirm}
      </Button>
      <ConfirmDialog
        open={confirming}
        onOpenChange={(open) => {
          setConfirming(open);
          if (!open) setError(null);
        }}
        title={copy.title}
        description={description ?? copy.description}
        confirmLabel={copy.confirm}
        onConfirm={rotate}
        error={error}
      />
      {reveal && (
        <SecretReveal open={revealed !== null} onOpenChange={(open) => !open && setRevealed(null)} title={copy.revealTitle} secrets={revealed ?? []} warning={copy.warning} />
      )}
    </>
  );
}
