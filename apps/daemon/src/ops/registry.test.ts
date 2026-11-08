import { describe, expect, test } from 'bun:test';
import { registry as daemonRegistry } from './metrics.ts';
import { createRegistry } from './registry.ts';

type Sample = { name: string; labels: Record<string, string>; value: number };
type Family = { name: string; help: string; type: string; samples: Sample[] };

const NAME = '[a-zA-Z_:][a-zA-Z0-9_:]*';
const LABEL_VALUE = '"(?:[^"\\\\\\n]|\\\\[\\\\n"])*"';
const SAMPLE = new RegExp(`^(${NAME})(?:\\{((?:[a-zA-Z_]\\w*=${LABEL_VALUE})(?:,[a-zA-Z_]\\w*=${LABEL_VALUE})*)?\\})? (\\S+)$`);
const LABEL = new RegExp(`([a-zA-Z_]\\w*)=(${LABEL_VALUE})`, 'g');
const unescape = (quoted: string) => quoted.slice(1, -1).replace(/\\(.)/g, (_, ch: string) => (ch === 'n' ? '\n' : ch));
const SUFFIXES: Record<string, string[]> = { counter: [''], gauge: [''], histogram: ['_bucket', '_sum', '_count'] };

/**
 * A strict parser for the Prometheus text format (0.0.4): every family has HELP then TYPE, every
 * sample belongs to the family declared above it under a name its type allows, and values parse.
 * Throws on the first violation.
 */
function parseExposition(text: string): Family[] {
  expect(text.endsWith('\n')).toBe(true);
  const families: Family[] = [];
  const lines = text.slice(0, -1).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const help = line.match(new RegExp(`^# HELP (${NAME}) (.*)$`));
    if (help) {
      const type = (lines[++i] ?? '').match(new RegExp(`^# TYPE ${help[1]} (counter|gauge|histogram)$`));
      if (!type) throw new Error(`line ${i + 1}: TYPE must follow HELP for ${help[1]}`);
      families.push({ name: help[1] ?? '', help: (help[2] ?? '').replace(/\\(.)/g, (_, ch: string) => (ch === 'n' ? '\n' : ch)), type: type[1] ?? '', samples: [] });
      continue;
    }
    const sample = line.match(SAMPLE);
    const family = families.at(-1);
    if (!sample || !family) throw new Error(`line ${i + 1}: not a sample: ${line}`);
    const [, name = '', labelText = '', valueText = ''] = sample;
    if (!SUFFIXES[family.type]?.some((suffix) => name === family.name + suffix)) throw new Error(`line ${i + 1}: ${name} outside its family`);
    const value = valueText === '+Inf' ? Infinity : valueText === '-Inf' ? -Infinity : Number(valueText);
    if (Number.isNaN(value) && valueText !== 'NaN') throw new Error(`line ${i + 1}: bad value ${valueText}`);
    family.samples.push({ name, labels: Object.fromEntries([...labelText.matchAll(LABEL)].map(([, k = '', v = '']) => [k, unescape(v)])), value });
  }
  return families;
}

describe('metrics registry', () => {
  test('renders counters, gauges and histograms in the Prometheus text format', async () => {
    const registry = createRegistry();
    const requests = registry.counter('test_requests_total', 'Requests\nby kind', ['kind', 'status']);
    const plain = registry.counter('test_plain_total', 'No labels');
    const leases = registry.gauge('test_leases', 'Leases', ['state']);
    const lag = registry.histogram('test_lag_seconds', 'Lag', [1, 0.1], ['provider']);

    requests.inc({ kind: 'ics', status: '200' });
    requests.inc({ status: '200', kind: 'ics' }, 2);
    requests.inc({ kind: 'cal"dav\\', status: '401' });
    plain.inc({});
    leases.set({ state: 'active' }, 3);
    for (const seconds of [0.05, 0.5, 5]) lag.observe({ provider: 'google' }, seconds);

    const families = parseExposition(await registry.render());
    expect(families).toEqual([
      {
        name: 'test_requests_total',
        help: 'Requests\nby kind',
        type: 'counter',
        samples: [
          { name: 'test_requests_total', labels: { kind: 'ics', status: '200' }, value: 3 },
          { name: 'test_requests_total', labels: { kind: 'cal"dav\\', status: '401' }, value: 1 },
        ],
      },
      { name: 'test_plain_total', help: 'No labels', type: 'counter', samples: [{ name: 'test_plain_total', labels: {}, value: 1 }] },
      { name: 'test_leases', help: 'Leases', type: 'gauge', samples: [{ name: 'test_leases', labels: { state: 'active' }, value: 3 }] },
      {
        name: 'test_lag_seconds',
        help: 'Lag',
        type: 'histogram',
        samples: [
          { name: 'test_lag_seconds_bucket', labels: { provider: 'google', le: '0.1' }, value: 1 },
          { name: 'test_lag_seconds_bucket', labels: { provider: 'google', le: '1' }, value: 2 },
          { name: 'test_lag_seconds_bucket', labels: { provider: 'google', le: '+Inf' }, value: 3 },
          { name: 'test_lag_seconds_sum', labels: { provider: 'google' }, value: 5.55 },
          { name: 'test_lag_seconds_count', labels: { provider: 'google' }, value: 3 },
        ],
      },
    ]);
  });

  test('counters refuse to go down', () => {
    expect(() => createRegistry().counter('test_total', 'x').inc({}, -1)).toThrow(RangeError);
  });

  test('the daemon registry declares the issue #22 metrics and renders without a database', async () => {
    expect(parseExposition(await daemonRegistry.render()).map((family) => family.name)).toEqual([
      'supercal_sync_duration_seconds',
      'supercal_sync_errors_total',
      'supercal_lease_lost_total',
      'supercal_resource_changes_total',
      'supercal_notify_lag_seconds',
      'supercal_feed_requests_total',
      'supercal_ics_cache_hits_total',
      'supercal_ics_cache_misses_total',
      'supercal_push_leases',
      'supercal_sink_writes_total',
    ]);
  });
});
