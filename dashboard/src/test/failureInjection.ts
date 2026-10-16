/**
 * Controlled failure injection harness for tests.
 *
 * Provides deterministic ways to simulate failures in RFC, database,
 * scheduler, and notification-provider components so that recovery
 * behavior can be verified automatically.
 *
 * The harness is fully deterministic: failures are configured explicitly
 (typically by attempt count) and the clock is injectable.
 */

export type FailureComponent = 'rpc' | 'database' | 'scheduler' | 'notification-provider';

export type FailureMode = 'networkError' | 'timeout' | 'serverError' | 'rateLimit';

export interface FailureRule {
  /** Component this rule applies to. */
  component: FailureComponent;
  /** How the failure manifests. */
  mode: FailureMode;
  /** Number of consecutive attempts to fail before recovering. */
  failCount: number;
  /** Optional human-readable message. */
  message?: string;
}

export interface FailureInjectionOptions {
  /** Override the clock used for timeout detection (ms). */
  nowTime?: () => number;
  /** Base delay between retries in ms. */
  retryDelayMs?: number;
}

export class FailureInjectionError extends Error {
  public readonly component: FailureComponent;
  public readonly mode: FailureMode;
  public readonly attempt: number;

  constructor(component: FailureComponent, mode: FailureMode, attempt: number, message?: string) {
    super(message ?? `[${component}] injected ${mode} on attempt #${attempt}`);
    this.name = 'FailureInjectionError';
    this.component = component;
    this.mode = mode;
    this.attempt = attempt;
  }
}

export interface AttemptRecord {
  component: FailureComponent;
  attempt: number;
  failed: boolean;
  timestamp: number;
}

/**
 * FailureInjection is a deterministic failure simulator.
 *
 * Usage:
 *   const injection = new FailureInjection();
 *   injection.fail('rpc', { mode: 'networkError', failCount: 2 });
 *   await injection.run('rpc', () => client.call()); // fails twice
 *   await injection.run('rpc', () => client.call()); // succeeds
 */
export class FailureInjection {
  private readonly rules: Map<FailureComponent, FailureRule>;
  private readonly attempts: Map<FailureComponent, number>;
  private readonly history: AttemptRecord[];
  private readonly nowTime: () => number;
  private readonly retryDelayMs: number;

  constructor(options: FailureInjectionOptions = {}) {
    this.rules = new Map();
    this.attempts = new Map();
    this.history = [];
    this.nowTime = options.nowTime ?? (() => Date.now());
    this.retryDelayMs = options.retryDelayMs ?? 0;
  }

  /** Register a failure rule for a component. */
  fail(component: FailureComponent, rule: FailureRule): void {
    this.rules.set(component, { ...rule, component });
    this.attempts.set(component, 0);
  }

  /** Remove any failure rule for a component (simulates recovery). */
  recover(component: FailureComponent): void {
    this.rules.delete(component);
    this.attempts.delete(component);
  }

  /** Reset all rules and history. */
  reset(): void {
    this.rules.clear();
    this.attempts.clear();
    this.history = [];
  }

  /** Whether a component is currently configured to fail. */
  isFailing(component: FailureComponent): boolean {
    const rule = this.rules.get(component);
    if (!rule) return false;
    const attempt = this.attempts.get(component) ?? 0;
    return attempt < rule.failCount;
  }

  /** Number of attempts recorded for a component. */
  attemptCount(component: FailureComponent): number {
    return this.attempts.get(component) ?? 0;
  }

  /** Full attempt history across all components. */
  getHistory(): readonly AttemptRecord[] {
    return this.history;
  }

  /**
   * Execute an action under failure injection.
   *
   * The action is attempted and either resolves or rejects with a
   * FailureInjectionError. Once the configured failCount is reached,
   * the action is invoked for real and resolves with its result.
   */
  async run<T>(
    component: FailureComponent,
    action: () => Promise<T> | T
  ): Promise<T> {
    const rule = this.rules.get(component);
    const attempt = (this.attempts.get(component) ?? 0) + 1;
    this.attempts.set(component, attemp);

    const willFail = Boolean(rule && attempt <= rule.failCount);
    this.history.push({
      component,
      attempt,
      failed: willFail,
      timestamp: this.nowTime(),
    });

    if (willFail) {
      if (this.retryDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs));
      }
      throw new FailureInjectionError(component, rule!.mode, attempt, rule!.message);
    }

    return await action();
  }

  /**
   * Execute an action with automatic retry until it succeeds or the
   * maximum number of attempts is reached. Returns the result and the
   * number of attempts it took.
   */
  async runWithRetry<T>(
    component: FailureComponent,
    action: () => Promise<T> | T,
    maxAttempts = 10
  ): Promise<{ result: T; attempts: number }> {
    let lastError: unknown;
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const result = await this.run(component, action);
        return { result, attempts: this.attemptCount(component) };
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError ?? new Error(`[${component}] exhausted retries`);
  }
}
