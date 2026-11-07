type Level = 'debug' | 'info' | 'warn' | 'error';
type Fields = Record<string, unknown>;

export type Logger = Record<Level, (msg: string, fields?: Fields) => void> & {
  /** Returns a logger that adds `fields` to every line. */
  child(fields: Fields): Logger;
};

const errorsAsObjects = (_key: string, value: unknown) =>
  value instanceof Error ? { name: value.name, message: value.message, stack: value.stack } : value;

/** Structured logger writing one JSON object per line: `level`, `msg`, `time`, then context fields. */
export function createLogger(context: Fields = {}, write: (line: string) => void = (line) => process.stdout.write(line)): Logger {
  const emit = (level: Level) => (msg: string, fields?: Fields) =>
    write(`${JSON.stringify({ level, msg, time: new Date().toISOString(), ...context, ...fields }, errorsAsObjects)}\n`);
  return {
    debug: emit('debug'),
    info: emit('info'),
    warn: emit('warn'),
    error: emit('error'),
    child: (fields) => createLogger({ ...context, ...fields }, write),
  };
}

/**
 * Makes a URL or request path safe to log: drops credentials, replaces the query and fragment with
 * `…`, and hides every path segment after `/ics/` (feed tokens). Anything that is not a URL or path
 * is treated as a secret and replaced entirely.
 */
export function redact(value: string): string {
  const isPath = value.startsWith('/');
  const url = URL.parse(value, isPath ? 'http://path.invalid' : undefined);
  if (!url) return '…';
  const path = url.pathname.replace(/(^|\/)ics\/.+$/, '$1ics/…');
  const tail = `${path}${url.search ? '?…' : ''}${url.hash ? '#…' : ''}`;
  return isPath ? tail : `${url.protocol}//${url.host}${tail}`;
}
