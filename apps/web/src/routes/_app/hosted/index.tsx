/** Hosted (docs/product.md screen 5): the user's hosted calendars, those shared with them, and deleted ones to restore. */
import { createFileRoute, Link } from '@tanstack/react-router';
import { useState } from 'react';
import { ToastProvider } from '../../../components/accounts/toast.tsx';
import { HostedList } from '../../../components/hosted/hosted-list.tsx';
import { NewCalendarDialog } from '../../../components/hosted/new-calendar-dialog.tsx';
import { PageHeader } from '../../../components/page-header.tsx';
import { Button, buttonClass } from '../../../components/ui/button.tsx';

export const Route = createFileRoute('/_app/hosted/')({
  component: () => (
    <ToastProvider>
      <Hosted />
    </ToastProvider>
  ),
});

function Hosted() {
  const [creating, setCreating] = useState(false);
  return (
    <div className="max-w-3xl">
      <PageHeader
        title="Hosted"
        actions={
          <>
            <Link to="/settings" hash="devices" className={buttonClass()}>
              Connect an app
            </Link>
            <Button variant="primary" onClick={() => setCreating(true)}>
              New calendar
            </Button>
          </>
        }
      />
      <HostedList onCreate={() => setCreating(true)} />
      <NewCalendarDialog open={creating} onOpenChange={setCreating} />
    </div>
  );
}
