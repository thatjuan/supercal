/** Settings › Appearance: the same theme preference as the user menu (theme.ts). */
import { useTheme, type ThemePreference } from '../../theme.ts';
import { cx } from '../ui/cx.ts';
import { Panel } from '../ui/panel.tsx';

const THEMES: { value: ThemePreference; label: string }[] = [
  { value: 'system', label: 'Match system' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

export function ThemeSettings() {
  const { preference, setPreference } = useTheme();
  return (
    <Panel title="Appearance" description="Stored in this browser.">
      <div role="radiogroup" aria-label="Theme" className="inline-flex flex-wrap gap-1 rounded-[10px] bg-surface-2 p-1">
        {THEMES.map((theme) => (
          <button
            key={theme.value}
            type="button"
            role="radio"
            aria-checked={preference === theme.value}
            onClick={() => setPreference(theme.value)}
            className={cx('h-8 rounded-lg px-3.5 text-sm text-ink-2', preference === theme.value && 'bg-surface font-semibold text-ink shadow-xs')}
          >
            {theme.label}
          </button>
        ))}
      </div>
    </Panel>
  );
}
