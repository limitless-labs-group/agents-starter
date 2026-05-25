/**
 * Shared state between the Polymarket WS listener and the per-pair
 * replicator loops.
 *
 * Port of the QuoteFeed dataclass + per-slug asyncio.Event from
 * `clients/poly_ws.py` in the Python original. asyncio.Event semantics map
 * to a Promise-based primitive here ("waiter resolves on next update").
 *
 * Everything stored is in **YES-frame**: even if the WS update was for the
 * NO asset, the listener inverts to YES_ask = 1 - NO_bid, YES_bid = 1 - NO_ask
 * before writing. Consumers can assume `bid` and `ask` refer to YES.
 */

export interface Quote {
  /** Best YES bid in probability units (0..1). */
  bid: number | null;
  /** Best YES ask in probability units (0..1). */
  ask: number | null;
}

export function quoteMid(q: Quote): number | null {
  if (q.bid != null && q.ask != null) return (q.bid + q.ask) / 2;
  return null;
}

/**
 * Per-slug "wake on next update" + latest quote.
 *
 * Each replicator task awaits `nextUpdate(slug)` which resolves when the
 * WS listener calls `update(slug, ...)`. Resolution clears the waiter
 * so the next call re-awaits.
 */
export class QuoteFeed {
  private readonly quotes = new Map<string, Quote>();
  private readonly waiters = new Map<string, Set<() => void>>();

  ensureSlug(slug: string): void {
    if (!this.quotes.has(slug)) this.quotes.set(slug, { bid: null, ask: null });
    if (!this.waiters.has(slug)) this.waiters.set(slug, new Set());
  }

  getQuote(slug: string): Quote | undefined {
    return this.quotes.get(slug);
  }

  /**
   * Partial update — only mutate the side(s) provided.
   * Polymarket price_change events arrive one side at a time; book
   * snapshots include both. We honor the partial-update semantic so a
   * stale side doesn't get clobbered by a missing field.
   */
  update(slug: string, bid: number | null | undefined, ask: number | null | undefined): void {
    this.ensureSlug(slug);
    const q = this.quotes.get(slug)!;
    if (bid !== undefined) q.bid = bid;
    if (ask !== undefined) q.ask = ask;
    this.fireWaiters(slug);
  }

  /**
   * Resolves on the next `update()` for this slug, OR when `signal` aborts.
   * Re-awaitable. The abort path is load-bearing: on shutdown the WS closes
   * and stops pushing updates, so without it a consumer loop would block here
   * forever and never reach its cleanup (e.g. cancel-all).
   *
   * @example
   *   while (!signal.aborted) {
   *     await feed.nextUpdate(slug, signal);
   *     const q = feed.getQuote(slug);
   *     ...
   *   }
   */
  nextUpdate(slug: string, signal?: AbortSignal): Promise<void> {
    this.ensureSlug(slug);
    if (signal?.aborted) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const set = this.waiters.get(slug)!;
      const settle = () => {
        set.delete(settle);
        resolve();
      };
      set.add(settle);
      signal?.addEventListener('abort', settle, { once: true });
    });
  }

  private fireWaiters(slug: string): void {
    const set = this.waiters.get(slug);
    if (!set || set.size === 0) return;
    // Snapshot + clear so a waiter that immediately re-arms in its resolve
    // handler ends up on the *next* set, not this one.
    const snapshot = [...set];
    set.clear();
    for (const resolve of snapshot) resolve();
  }
}
