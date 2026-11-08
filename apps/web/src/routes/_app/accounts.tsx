/**
 * Accounts (docs/product.md screen 3): every connected account with its health, and adding or
 * reconnecting one. OAuth providers come back here as `?connected=1&accountId=…` or `?error=<code>`,
 * which shows a toast once and is then cleared from the address.
 */
import { useQuery } from '@tanstack/react-query';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { meQuery } from '../../api.ts';
import { AccountRow } from '../../components/accounts/account-list.tsx';
import { ConnectDialog } from '../../components/accounts/connect-dialog.tsx';
import { accountsQuery, calendarsByAccount, calendarsQuery, instanceQuery, useOAuth } from '../../components/accounts/data.ts';
import type { Account, Provider } from '../../components/accounts/health.ts';
import { oauthSearch, oauthToast, type OAuthSearch } from '../../components/accounts/oauth-return.ts';
import { ProviderPicker } from '../../components/accounts/provider-picker.tsx';
import { isOAuth, type FormProvider } from '../../components/accounts/providers.tsx';
import { ToastProvider, useToast } from '../../components/accounts/toast.tsx';
import { PageHeader } from '../../components/page-header.tsx';
import { Button } from '../../components/ui/button.tsx';
import { Dialog, DialogContent } from '../../components/ui/dialog.tsx';
import { Icon } from '../../components/ui/icon.tsx';
import { ProblemAlert, toProblem } from '../../components/ui/problem-alert.tsx';

export const Route = createFileRoute('/_app/accounts')({
  validateSearch: (search): OAuthSearch => oauthSearch(search),
  component: () => (
    <ToastProvider>
      <Accounts />
    </ToastProvider>
  ),
});

const RETURN_TO = '/accounts?connected=1';

function Accounts() {
  const toast = useToast();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const me = useQuery(meQuery);
  const accounts = useQuery(accountsQuery);
  const calendars = useQuery(calendarsQuery);
  const instance = useQuery(instanceQuery);
  const [picking, setPicking] = useState(false);
  const [form, setForm] = useState<{ provider: FormProvider; account?: Account } | null>(null);
  const oauth = useOAuth((error) => toast({ tone: 'error', message: toProblem(error).detail ?? toProblem(error).title }));

  useEffect(() => {
    const notice = oauthToast(search);
    if (!notice) return;
    toast(notice);
    void navigate({ search: {}, replace: true });
  }, [search, toast, navigate]);

  const pick = (provider: Provider) => {
    setPicking(false);
    if (isOAuth(provider)) oauth.connect(provider, RETURN_TO);
    else setForm({ provider });
  };
  const reconnect = (account: Account) => {
    const { provider } = account;
    if (isOAuth(provider)) oauth.reconnect(account.id, RETURN_TO);
    else setForm({ provider, account });
  };

  const groups = calendarsByAccount(calendars.data?.items);
  const items = accounts.data?.items ?? [];
  // Admins list every account in the tenant; their own come first.
  const sorted = [...items].sort((a, b) => Number(b.ownerUserId === me.data?.user.id) - Number(a.ownerUserId === me.data?.user.id));

  return (
    <>
      <PageHeader
        title="Accounts"
        actions={
          <Button variant="primary" onClick={() => setPicking(true)} disabled={oauth.pending}>
            <Icon name="plus" className="size-4" />
            Add account
          </Button>
        }
      />
      {accounts.error && <ProblemAlert problem={toProblem(accounts.error)} className="max-w-3xl" />}
      {accounts.data && (
        <section aria-labelledby="accounts-heading" className="max-w-5xl rounded-[14px] border border-line bg-surface shadow-xs">
          <h2 id="accounts-heading" className="border-b border-line px-5 py-3.5 text-[17px] font-semibold">
            Accounts ({items.length})
          </h2>
          {items.length === 0 ? (
            <p className="px-5 py-6 text-[15px] text-ink-2">No accounts yet. Add one to start publishing its calendars.</p>
          ) : (
            <ul>
              {sorted.map((account) => (
                <AccountRow key={account.id} account={account} calendars={groups.get(account.id) ?? []} onReconnect={reconnect} />
              ))}
            </ul>
          )}
        </section>
      )}

      <Dialog open={picking} onOpenChange={setPicking}>
        <DialogContent title="Add an account" description="Choose where your calendars live." className="w-[min(40rem,calc(100vw-2rem))]">
          <ProviderPicker instance={instance.data} onPick={pick} />
        </DialogContent>
      </Dialog>
      <ConnectDialog
        provider={form?.provider ?? null}
        account={form?.account}
        onOpenChange={(open) => !open && setForm(null)}
        onDone={(account) => {
          setForm(null);
          toast({ tone: 'success', message: form?.account ? `${account.displayName} reconnected` : `${account.displayName} connected` });
        }}
      />
    </>
  );
}
