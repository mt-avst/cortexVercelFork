/**
 * A counting semaphore with a FIFO waiting queue.
 *
 * Lives here because two different things now need to bound OCCUPANCY rather
 * than arrivals, and they bound different resources: firsthand's admission cap
 * bounds connections out of a five-connection pool, and the results-read gate
 * bounds how many multi-hundred-megabyte result sets are in the heap of a
 * single-replica 2Gi pod at once. A rate limiter can do neither - it counts
 * hits per window and has no notion of a request still running.
 *
 * FIFO rather than LIFO because the queue is what decides fairness between two
 * waiters, and a LIFO queue starves the one that has already waited longest -
 * which is the failure mode both callers exist to remove, reproduced one level
 * down.
 */
export class Semaphore {
  private available: number;

  private readonly waiting: Array<() => void> = [];

  constructor(private readonly permits: number) {
    this.available = permits;
  }

  tryAcquire(): boolean {
    if (this.available <= 0) {
      return false;
    }

    this.available -= 1;
    return true;
  }

  /**
   * Resolves once a permit is held, or rejects - with `onTimeout()` at
   * `timeoutMs`, or with `SemaphoreAbandonedError` if `signal` aborts first.
   *
   * The timeout error is built by the caller rather than thrown from here,
   * because what a timeout MEANS differs between the two users - one is a pool
   * that is busy, the other is a report queue that is full - and an operator
   * reading a log has to be able to tell them apart.
   *
   * THE WAITER IS REMOVED FROM THE QUEUE ON EVERY EXIT, and that is the whole
   * of what this method has to get right. A waiter left behind is handed a
   * permit by the next `release()`; nobody is holding it and nobody will ever
   * give it back, so the ceiling narrows by one permanently. Two of those and
   * a semaphore of two is closed for the life of the process. That is not
   * hypothetical - it is what shipped, reachable by a caller closing a tab
   * while queued, and three separate reproductions found it.
   *
   * `signal` exists for exactly that case. Guarding at the grant instead -
   * take the permit, notice the caller has gone, hand it straight back - is
   * correct on the accounting but still wrong: the dead waiter keeps its place
   * in a FIFO queue and a live caller waits behind somebody who left.
   */
  acquire(
    timeoutMs: number,
    onTimeout: () => Error,
    signal?: AbortSignal
  ): Promise<void> {
    if (signal?.aborted) {
      // Refused BEFORE `tryAcquire`, so an abandoned request cannot take a
      // permit it will never use even when one is free.
      return Promise.reject(new SemaphoreAbandonedError());
    }

    if (this.tryAcquire()) {
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      const leaveQueue = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        const index = this.waiting.indexOf(waiter);
        if (index !== -1) {
          this.waiting.splice(index, 1);
        }
      };

      const waiter = () => {
        // Already removed by `release`, which shifts before it calls. The
        // splice in `leaveQueue` is a no-op here and the listeners still have
        // to come off.
        leaveQueue();
        resolve();
      };

      const onAbort = () => {
        leaveQueue();
        reject(new SemaphoreAbandonedError());
      };

      const timer = setTimeout(() => {
        leaveQueue();
        reject(onTimeout());
      }, timeoutMs);

      // A pending timer keeps the Node event loop alive. A request waiting
      // here is a request in flight, so that is correct in the server - but
      // the timer must never be the reason a test process refuses to exit.
      timer.unref();

      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiting.push(waiter);
    });
  }

  release(): void {
    const next = this.waiting.shift();

    if (next) {
      // Handed straight on rather than returned to the pool and re-taken: a
      // release that incremented `available` first would let an acquirer
      // arriving in the same tick jump the queue.
      next();
      return;
    }

    this.available = Math.min(this.available + 1, this.permits);
  }

  /** Test seam. Reading these is how a leaked permit becomes visible. */
  stats(): { available: number; waiting: number } {
    return { available: this.available, waiting: this.waiting.length };
  }
}

/**
 * Thrown when a waiter's caller went away before a permit was free.
 *
 * Distinct from the timeout error because the two need opposite handling: a
 * timeout has somebody to answer with a 503, and this one has nobody left to
 * answer at all. Reporting it as an error would mean writing to a response
 * that has already closed.
 */
export class SemaphoreAbandonedError extends Error {
  constructor() {
    super('The caller went away before a permit was available.');
    this.name = 'SemaphoreAbandonedError';
  }
}

/**
 * Wraps `release` so calling it twice cannot invent a permit.
 *
 * Every caller releases in a `finally` or an event handler, and both are
 * places a second call is easy to arrive at. Without this the extra release is
 * handed straight to a waiter and the ceiling is silently one wider for as
 * long as that request runs - and the `Math.min` clamp above hides it, because
 * with nobody queued the count still reads correctly.
 */
export function releaseOnce(semaphore: Semaphore): () => void {
  let released = false;

  return () => {
    if (released) {
      return;
    }
    released = true;
    semaphore.release();
  };
}
