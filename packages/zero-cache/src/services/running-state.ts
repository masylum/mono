import {LogContext} from '@rocicorp/logger';
import {resolver} from '@rocicorp/resolver';
import {sleepWithAbort} from 'shared/src/sleep.js';

const DEFAULT_INITIAL_RETRY_DELAY_MS = 100;
const DEFAULT_MAX_RETRY_DELAY_MS = 10000;

export type RetryConfig = {
  initialRetryDelay?: number;
  maxRetryDelay?: number;
};

/**
 * Facilitates lifecycle control with exponential backoff.
 */
export class RunningState {
  readonly #serviceName: string;
  readonly #initialRetryDelay: number;
  readonly #maxRetryDelay: number;
  #retryDelay: number;

  #shouldRun = true;
  #stopped = resolver();

  constructor(serviceName: string, retryConfig?: RetryConfig) {
    const {
      initialRetryDelay = DEFAULT_INITIAL_RETRY_DELAY_MS,
      maxRetryDelay = DEFAULT_MAX_RETRY_DELAY_MS,
    } = retryConfig ?? {};

    this.#serviceName = serviceName;
    this.#initialRetryDelay = initialRetryDelay;
    this.#maxRetryDelay = maxRetryDelay;
    this.#retryDelay = initialRetryDelay;
  }

  /**
   * Returns `true` until {@link stop()} has been called.
   *
   * This is usually called as part of the service's main loop
   * conditional to determine if the next iteration should execute.
   */
  shouldRun(): boolean {
    return this.#shouldRun;
  }

  /**
   * Called to stop the service. After this is called, {@link shouldRun()}
   * will return `false` and the {@link stopped()} Promise will be resolved.
   */
  stop(lc: LogContext, err?: unknown): void {
    if (this.#shouldRun) {
      if (err) {
        lc.error?.(`stopping ${this.#serviceName} with error`, err);
      } else {
        lc.info?.(`stopping ${this.#serviceName}`);
      }

      this.#shouldRun = false;
      this.#stopped.resolve();
    }
  }

  /**
   * Returns a Promise that resolves when {@link stop()} is called.
   * This is used internally to cut off a {@link backoff()} delay, but
   * can also be used explicitly in a `Promise.race(...)` call to stop
   * stop waiting for work.
   */
  stopped(): Promise<void> {
    return this.#stopped.promise;
  }

  /**
   * Call in response to an error or unexpected termination in the main
   * loop of the service. The returned Promise will resolve after an
   * exponential delay, or once {@link stop()} is called.
   */
  async backoff(lc: LogContext): Promise<void> {
    const delay = this.#retryDelay;
    this.#retryDelay = Math.min(delay * 2, this.#maxRetryDelay);

    if (this.#shouldRun) {
      lc.info?.(`retrying ${this.#serviceName} in ${delay} ms`);

      const ac = new AbortController();
      const [timeout] = sleepWithAbort(delay, ac.signal);
      await Promise.race([timeout, this.#stopped.promise]);
      ac.abort();
    }
  }

  /**
   * When using {@link backoff()}, this method should be called when the
   * implementation receives a healthy signal (e.g. a successful
   * response). This resets the delay used in {@link backoff()}.
   */
  resetBackoff() {
    this.#retryDelay = this.#initialRetryDelay;
  }
}
