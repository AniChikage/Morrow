/**
 * The daemon's operational log: one JSON object per line on stdout, which is where the login agent
 * and the Electron main both point `service.log`, so a person diagnosing a stuck daemon can read
 * what it did instead of guessing from an empty file.
 *
 * It records lifecycle facts only — a boot, a shutdown signal, a scheduled turn that failed, an
 * upgrade phase change, an unhandled rejection. Request bodies, query strings and headers are never
 * passed to it, the same rule the request error path already follows, and every line goes through
 * the daemon's redactor so a value that happens to contain the service token cannot be written.
 *
 * Logging never throws and never changes what the caller was doing.
 */
export type LogFields = Record<string, unknown>;
type Sink = (line: string) => void;

const stdout: Sink = (line) => {
  try {
    process.stdout.write(line + '\n');
  } catch {
    /* A closed or full stdout is not worth failing a boot or a shutdown over. */
  }
};
/** Test mode is silent unless a test installs a sink, so 400 isolated services do not narrate. */
let sink: Sink | undefined = process.env.MORROW_TEST_MODE === '1' ? undefined : stdout;
let redact: (value: string) => string = (value) => value;
/** One value per field, so a long stack or message cannot turn one line into a page. */
const fieldLimit = 500;

/** Installed by the server once the service token is known; every line is redacted with it. */
export function setLogRedactor(fn: (value: string) => string) {
  redact = fn;
}
/** A test reads the lines it produced; `undefined` restores this process's normal destination. */
export function setLogSink(fn?: Sink) {
  sink = fn ?? (process.env.MORROW_TEST_MODE === '1' ? undefined : stdout);
}
export function log(event: string, fields: LogFields = {}) {
  if (!sink) return;
  try {
    const bounded: LogFields = {};
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) continue;
      bounded[key] = typeof value === 'string' && value.length > fieldLimit ? value.slice(0, fieldLimit) + '…' : value;
    }
    sink(redact(JSON.stringify({ at: new Date().toISOString(), event, ...bounded })));
  } catch {
    /* A field that cannot be serialized loses its line, never the operation it describes. */
  }
}
/** The same line with the reason of a caught failure, which is the only part of an error kept. */
export function logError(event: string, error: unknown, fields: LogFields = {}) {
  log(event, { ...fields, reason: error instanceof Error ? error.message : String(error) });
}
