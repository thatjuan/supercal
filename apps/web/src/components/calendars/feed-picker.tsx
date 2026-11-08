import { Icon } from '../ui/icon.tsx';
import type { Feed } from './data.ts';

/** Chooses the feed a screen works on; renders nothing when the user has only one. */
export function FeedPicker({ feeds, value, onChange }: { feeds: Feed[]; value: Feed; onChange: (feedId: string) => void }) {
  if (feeds.length < 2) return null;
  return (
    <label className="relative mb-5 inline-flex h-11 w-72 max-w-full items-center rounded-[10px] border border-line-strong bg-surface shadow-xs focus-within:ring-2 focus-within:ring-accent/25">
      <Icon name="calendar" className="pointer-events-none absolute left-3.5 text-ink-2" />
      <span className="sr-only">Feed</span>
      <select value={value.id} onChange={(e) => onChange(e.target.value)} className="h-full w-full appearance-none bg-transparent pr-9 pl-11 text-[15px] outline-none">
        {feeds.map((feed) => (
          <option key={feed.id} value={feed.id}>
            {feed.name}
          </option>
        ))}
      </select>
      <Icon name="chevron" className="pointer-events-none absolute right-3.5 size-4 text-ink-2" />
    </label>
  );
}
