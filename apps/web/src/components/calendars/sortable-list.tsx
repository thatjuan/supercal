/**
 * A drag-to-reorder list, used for virtual calendar source priority and publication order. Rows
 * drag with the mouse (native drag and drop); the grip handle also moves its row with the Up and
 * Down arrow keys.
 */
import { useState, type ReactNode } from 'react';
import { cx } from '../ui/cx.ts';
import { Icon } from '../ui/icon.tsx';

/** `items` with the item at `from` moved to `to`. */
export function move<T>(items: readonly T[], from: number, to: number): T[] {
  const next = [...items];
  const [item] = next.splice(from, 1);
  if (item === undefined) return next;
  next.splice(Math.max(0, Math.min(to, next.length)), 0, item);
  return next;
}

type Props<T> = {
  items: readonly T[];
  keyOf: (item: T) => string;
  labelOf: (item: T) => string;
  onReorder: (items: T[]) => void;
  children: (item: T, index: number) => ReactNode;
  label: string;
  className?: string;
};

export function SortableList<T>({ items, keyOf, labelOf, onReorder, children, label, className }: Props<T>) {
  const [dragging, setDragging] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);

  const reorder = (from: number, to: number) => {
    if (from !== to && to >= 0 && to < items.length) onReorder(move(items, from, to));
  };

  return (
    <ol aria-label={label} className={cx('grid', className)}>
      {items.map((item, index) => (
        <li
          key={keyOf(item)}
          draggable
          onDragStart={(event) => {
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', String(index));
            setDragging(index);
          }}
          onDragOver={(event) => {
            event.preventDefault();
            setOver(index);
          }}
          onDrop={(event) => {
            event.preventDefault();
            if (dragging !== null) reorder(dragging, index);
            setDragging(null);
            setOver(null);
          }}
          onDragEnd={() => {
            setDragging(null);
            setOver(null);
          }}
          className={cx(
            'flex items-center gap-2 border-t border-line py-1.5 first:border-t-0',
            dragging === index && 'opacity-40',
            over === index && dragging !== null && dragging !== index && 'shadow-[inset_0_2px_0_var(--accent)]',
          )}
        >
          <button
            type="button"
            aria-label={`Move ${labelOf(item)}`}
            aria-description="Use the up and down arrow keys to reorder"
            onKeyDown={(event) => {
              const step = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0;
              if (step === 0) return;
              event.preventDefault();
              reorder(index, index + step);
            }}
            className="cursor-grab rounded p-1 text-ink-3 hover:bg-surface-2 hover:text-ink active:cursor-grabbing"
          >
            <Icon name="grip" className="size-4" />
          </button>
          <span className="w-5 text-right text-xs text-ink-3 tabular-nums">{index + 1}</span>
          <div className="min-w-0 flex-1">{children(item, index)}</div>
        </li>
      ))}
    </ol>
  );
}
