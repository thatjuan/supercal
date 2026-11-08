/** Settings › Profile: the user's name (Better Auth `updateUser`), email, and password change. */
import type { Problem } from '@supercal/api-client';
import { useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { meQuery } from '../../api.ts';
import { authClient } from '../../auth.ts';
import { Button } from '../ui/button.tsx';
import { Field } from '../ui/field.tsx';
import { Panel } from '../ui/panel.tsx';
import { ProblemAlert, toProblem } from '../ui/problem-alert.tsx';

const MIN_PASSWORD = 8;

/** Form state shared by both forms: pending, the last problem, and a short success note. */
function useFormState() {
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [done, setDone] = useState<string | null>(null);
  async function run(action: () => Promise<{ error: unknown }>, success: string) {
    setPending(true);
    setProblem(null);
    setDone(null);
    try {
      const { error } = await action();
      if (error) setProblem(toProblem(error));
      else setDone(success);
    } catch (failure) {
      setProblem(toProblem(failure));
    } finally {
      setPending(false);
    }
  }
  return { pending, problem, done, run };
}

export function ProfileSettings({ user }: { user: { name: string; email: string } }) {
  const queryClient = useQueryClient();
  const profile = useFormState();
  const password = useFormState();

  function saveName(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = String(new FormData(event.currentTarget).get('name')).trim();
    void profile.run(async () => {
      const result = await authClient.updateUser({ name });
      await queryClient.invalidateQueries({ queryKey: meQuery.queryKey });
      return result;
    }, 'Name saved.');
  }

  function changePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    void password.run(async () => {
      const result = await authClient.changePassword({
        currentPassword: String(data.get('currentPassword')),
        newPassword: String(data.get('newPassword')),
        revokeOtherSessions: true,
      });
      if (!result.error) form.reset();
      return result;
    }, 'Password changed. Other sessions were signed out.');
  }

  return (
    <Panel title="Profile">
      <div className="grid gap-6 md:grid-cols-2">
        <form onSubmit={saveName} className="grid content-start gap-3">
          {profile.problem && <ProblemAlert problem={profile.problem} />}
          <Field label="Name" name="name" defaultValue={user.name} autoComplete="name" required maxLength={100} />
          <Field label="Email" value={user.email} readOnly hint="Your sign-in address." className="bg-surface-2" />
          <div className="flex items-center gap-3">
            <Button type="submit" disabled={profile.pending}>
              Save name
            </Button>
            {profile.done && <span role="status" className="text-sm text-accent-text">{profile.done}</span>}
          </div>
        </form>
        <form onSubmit={changePassword} className="grid content-start gap-3">
          {password.problem && <ProblemAlert problem={password.problem} />}
          <Field label="Current password" name="currentPassword" type="password" autoComplete="current-password" required />
          <Field label="New password" name="newPassword" type="password" autoComplete="new-password" minLength={MIN_PASSWORD} required hint={`At least ${MIN_PASSWORD} characters.`} />
          <div className="flex items-center gap-3">
            <Button type="submit" disabled={password.pending}>
              Change password
            </Button>
            {password.done && <span role="status" className="text-sm text-accent-text">{password.done}</span>}
          </div>
        </form>
      </div>
    </Panel>
  );
}
