/**
 * A minimal Prometheus registry: counters, gauges and fixed-bucket histograms, rendered in the text
 * exposition format (version 0.0.4). Label names are part of each metric's type, so every call
 * site must pass exactly those labels:
 *
 *   const errors = registry.counter('supercal_sync_errors_total', 'Failed syncs', ['provider', 'kind']);
 *   errors.inc({ provider: 'google', kind: 'auth' });
 *
 * `collect` hooks run before each render, for gauges read from the database at scrape time.
 */

/** A metric's labels: `{}` when it has none. */
type Labels<L extends string> = Record<L, string>;

type Series<L extends string, V> = Map<string, { labels: Labels<L>; value: V }>;

type HistogramValue = { buckets: number[]; sum: number; count: number };

const escapeLabel = (value: string) => value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
const escapeHelp = (value: string) => value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');

/** `{a="1",b="2"}`, or nothing without labels. */
const labelText = (labels: Record<string, string>) => {
  const pairs = Object.entries(labels).map(([name, value]) => `${name}="${escapeLabel(value)}"`);
  return pairs.length > 0 ? `{${pairs.join(',')}}` : '';
};

const numberText = (value: number) => (value === Infinity ? '+Inf' : value === -Infinity ? '-Inf' : Number.isNaN(value) ? 'NaN' : String(value));

/** The series for `labels` in `series`, created with `initial()` on first use. Keys follow `names` order. */
function seriesFor<L extends string, V>(series: Series<L, V>, names: readonly L[], labels: Labels<L>, initial: () => V) {
  const ordered = Object.fromEntries(names.map((name) => [name, labels[name]])) as Labels<L>;
  const key = JSON.stringify(names.map((name) => labels[name]));
  let entry = series.get(key);
  if (!entry) series.set(key, (entry = { labels: ordered, value: initial() }));
  return entry;
}

export function createRegistry() {
  const renderers: (() => string[])[] = [];
  const collectors: (() => Promise<void>)[] = [];

  const header = (name: string, help: string, type: string) => [`# HELP ${name} ${escapeHelp(help)}`, `# TYPE ${name} ${type}`];

  function scalar<L extends string>(type: 'counter' | 'gauge', name: string, help: string, labelNames: readonly L[]) {
    const series: Series<L, number> = new Map();
    renderers.push(() => [...header(name, help, type), ...[...series.values()].map(({ labels, value }) => `${name}${labelText(labels)} ${numberText(value)}`)]);
    return {
      series,
      add: (labels: Labels<L>, by: number) => {
        seriesFor(series, labelNames, labels, () => 0).value += by;
      },
    };
  }

  return {
    /** A monotonically increasing count. */
    counter<L extends string = never>(name: string, help: string, labelNames: readonly L[] = []) {
      const { add } = scalar('counter', name, help, labelNames);
      return {
        inc(labels: Labels<L>, by = 1) {
          if (by < 0) throw new RangeError(`${name}: counters only go up`);
          add(labels, by);
        },
      };
    },

    /** A value that goes up and down. `reset` drops every series, before a collector sets fresh ones. */
    gauge<L extends string = never>(name: string, help: string, labelNames: readonly L[] = []) {
      const { series, add } = scalar('gauge', name, help, labelNames);
      return {
        set(labels: Labels<L>, value: number) {
          seriesFor(series, labelNames, labels, () => 0).value = value;
        },
        inc: (labels: Labels<L>, by = 1) => add(labels, by),
        reset: () => series.clear(),
      };
    },

    /** Observations counted into cumulative `buckets` (upper bounds, ascending; `+Inf` is implied). */
    histogram<L extends string = never>(name: string, help: string, buckets: readonly number[], labelNames: readonly L[] = []) {
      const bounds = [...buckets].sort((a, b) => a - b);
      const series: Series<L, HistogramValue> = new Map();
      renderers.push(() => [
        ...header(name, help, 'histogram'),
        ...[...series.values()].flatMap(({ labels, value }) => [
          ...[...bounds, Infinity].map((le, i) => `${name}_bucket${labelText({ ...labels, le: numberText(le) })} ${value.buckets[i]}`),
          `${name}_sum${labelText(labels)} ${numberText(value.sum)}`,
          `${name}_count${labelText(labels)} ${value.count}`,
        ]),
      ]);
      return {
        observe(labels: Labels<L>, value: number) {
          const entry = seriesFor(series, labelNames, labels, () => ({ buckets: Array<number>(bounds.length + 1).fill(0), sum: 0, count: 0 }));
          bounds.forEach((le, i) => {
            if (value <= le) entry.value.buckets[i]!++;
          });
          entry.value.buckets[bounds.length]!++;
          entry.value.sum += value;
          entry.value.count++;
        },
      };
    },

    /** Runs `fn` before every render; a failing collector is skipped, keeping its last values. */
    collect(fn: () => Promise<void>) {
      collectors.push(fn);
    },

    /** Runs the collectors, then renders every metric as Prometheus text. */
    async render(): Promise<string> {
      await Promise.allSettled(collectors.map((fn) => fn()));
      return `${renderers.flatMap((render) => render()).join('\n')}\n`;
    },
  };
}

export type Registry = ReturnType<typeof createRegistry>;

/** The text format's content type. */
export const PROMETHEUS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';
