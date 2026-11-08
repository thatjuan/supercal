/**
 * Provider cards for connecting an account, in onboarding and the Add account dialog. Providers
 * this server cannot connect (OAuth without the operator's credentials) are greyed out.
 */
import type { components } from '@supercal/api-client';
import { cx } from '../ui/cx.ts';
import type { Provider } from './health.ts';
import { isAvailable, PROVIDER_ORDER, PROVIDERS, ProviderMark } from './providers.tsx';

type Instance = components['schemas']['Instance'];

export function ProviderPicker({ instance, onPick, disabled = false }: { instance: Instance | undefined; onPick: (provider: Provider) => void; disabled?: boolean }) {
  return (
    <ul className="grid gap-2.5 [grid-template-columns:repeat(auto-fill,minmax(min(100%,15rem),1fr))]">
      {PROVIDER_ORDER.map((provider) => {
        const available = isAvailable(provider, instance);
        return (
          <li key={provider}>
            <button
              type="button"
              disabled={!available || disabled}
              onClick={() => onPick(provider)}
              className={cx(
                'flex h-full w-full items-start gap-3 rounded-[12px] border border-line bg-surface px-4 py-3.5 text-left shadow-xs transition-colors',
                'hover:border-line-strong hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
                'disabled:pointer-events-none disabled:shadow-none',
                !available && 'bg-surface-2/60 [&_.mark]:opacity-40 [&_.mark]:grayscale',
              )}
            >
              <ProviderMark provider={provider} className="mark mt-0.5 size-6" />
              <span className="grid gap-0.5">
                <span className={cx('text-[15px] font-semibold', !available && 'text-ink-3')}>{PROVIDERS[provider].name}</span>
                <span className="text-[13px] text-ink-3">{available ? PROVIDERS[provider].blurb : 'Not configured on this server'}</span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
