/**
 * The connect (or, with `account`, reconnect) dialog for a credential provider: its form, wired to
 * `POST /accounts` or `PUT /accounts/{id}/credentials`. On success the account and calendar
 * queries refresh and `onDone` gets the account.
 */
import { useQueryClient } from '@tanstack/react-query';
import { $api } from '../../api.ts';
import { Dialog, DialogContent } from '../ui/dialog.tsx';
import { CaldavForm, IcloudForm, IcsForm } from './credential-forms.tsx';
import { refreshAccounts } from './data.ts';
import type { Account } from './health.ts';
import { PROVIDERS, type FormProvider } from './providers.tsx';

type Props = {
  provider: FormProvider | null;
  account?: Account | undefined;
  onOpenChange: (open: boolean) => void;
  onDone: (account: Account) => void;
};

const DESCRIPTIONS: Record<FormProvider, string> = {
  icloud: 'Supercal reads your iCloud calendars over CalDAV.',
  caldav: 'Any server that speaks CalDAV with a username and password.',
  ics: 'A read-only link to one calendar, such as a shared or exported calendar.',
};

export function ConnectDialog({ provider, account, onOpenChange, onDone }: Props) {
  const client = useQueryClient();
  const create = $api.useMutation('post', '/api/v1/accounts');
  const replace = $api.useMutation('put', '/api/v1/accounts/{id}/credentials');

  const finish = async (connected: Account) => {
    await refreshAccounts(client);
    onDone(connected);
  };
  const connect = async (body: Parameters<typeof create.mutateAsync>[0]['body']) => finish((await create.mutateAsync({ body })).account);
  const reconnect = async (id: string, body: Parameters<typeof replace.mutateAsync>[0]['body']) => finish(await replace.mutateAsync({ params: { path: { id } }, body }));
  const close = () => onOpenChange(false);

  const form = () => {
    switch (provider) {
      case 'ics':
        return <IcsForm reconnect={!!account} onCancel={close} onSubmit={({ url, ...rest }) => (account ? reconnect(account.id, { provider, url }) : connect({ provider, url, ...rest }))} />;
      case 'caldav':
        return (
          <CaldavForm
            reconnect={!!account}
            onCancel={close}
            onSubmit={(values) => (account ? reconnect(account.id, { provider, username: values.username, password: values.password }) : connect({ provider, ...values }))}
          />
        );
      case 'icloud':
        return <IcloudForm reconnect={!!account} onCancel={close} onSubmit={(values) => (account ? reconnect(account.id, { provider, ...values }) : connect({ provider, ...values }))} />;
      case null:
        return null;
    }
  };

  const title = provider ? (account ? `Reconnect ${account.displayName}` : `Connect ${PROVIDERS[provider].name}`) : '';
  return (
    <Dialog open={provider !== null} onOpenChange={onOpenChange}>
      {provider && (
        <DialogContent title={title} description={account ? 'Enter the new credentials. Supercal checks them before saving.' : DESCRIPTIONS[provider]}>
          {form()}
        </DialogContent>
      )}
    </Dialog>
  );
}
