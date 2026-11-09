import type { Unsubscribe } from './types.ts';

/**
 * Ordered listener set. `emit` awaits each listener in registration order and never lets a listener's
 * synchronous throw or rejected promise escape as an unhandled rejection; failures are returned to the caller.
 */
export class ListenerSet<Args extends unknown[]> {
  private readonly listeners = new Set<(...args: Args) => unknown>();

  add(listener: (...args: Args) => unknown): Unsubscribe {
    if (typeof listener !== 'function') throw new TypeError('listener must be a function');
    const entry = (...args: Args) => listener(...args);
    this.listeners.add(entry);
    return () => { this.listeners.delete(entry); };
  }

  get size(): number {
    return this.listeners.size;
  }

  clear(): void {
    this.listeners.clear();
  }

  /** Resolves to the number of listeners that threw or rejected. */
  async emit(...args: Args): Promise<number> {
    let failures = 0;
    for (const listener of [...this.listeners]) {
      if (!this.listeners.has(listener)) continue;
      try { await listener(...args); } catch { failures += 1; }
    }
    return failures;
  }
}
