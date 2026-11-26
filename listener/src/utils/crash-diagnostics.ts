/** Safe production crash diagnostics policy (#1262). */
import { redactString, redactValue } from './redact';

export function formatCrashDiagnostic(error: unknown): Record<string, unknown> {
  const e = error instanceof Error ? error : new Error(String(error));
  const diagnostic: Record<string, unknown> = {
    name: e.name,
    message: redactString(e.message),
  };
  // Production crash dumps never include stacks or cause chains.
  if (process.env.NODE_ENV !== 'production') {
    diagnostic.stack = e.stack ? redactString(e.stack) : undefined;
    const cause = (e as Error & { cause?: unknown }).cause;
    if (cause !== undefined) diagnostic.cause = redactValue(cause);
  }
  return diagnostic;
}

/** Install handlers that log only redacted summaries, never whole error objects. */
export function installCrashDiagnosticsHandlers(logger: { error: (m: string, meta?: unknown) => void }): void {
  for (const event of ['uncaughtException', 'unhandledRejection'] as const) {
    process.on(event, (error: unknown) => {
      logger.error('Process crash diagnostic', formatCrashDiagnostic(error));
      process.exitCode = 1;
    });
  }
}
