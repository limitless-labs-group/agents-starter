/**
 * template — the bare skeleton to build your own strategy on.
 *
 * Copy this directory, rename the class, and fill in `tick()`. Everything
 * else (the loop, DRY_RUN gating, order placement, taker-delay handling,
 * error recovery) is inherited from `BaseStrategy`.
 *
 * What a strategy is, in this repo:
 *   1. `initialize()`  — one-time setup: load state, connect feeds, warm caches.
 *   2. `tick()`        — every `tickIntervalMs`: read markets, decide, return
 *                        `TradeDecision[]`. Return `[]` to do nothing.
 *   3. `shutdown()`    — cleanup on SIGINT/SIGTERM: close feeds, cancel quotes.
 *   4. `getStats()`    — a snapshot for dashboards/heartbeats.
 *
 * The skeleton below scans the newest CLOB markets, computes a placeholder
 * "fair value" for each, and buys when the market is cheaper than that value
 * by more than `minEdge`. The fair-value function is the whole strategy;
 * replace it with your signal (an oracle, a model, a cross-venue quote...).
 */

import { BaseStrategy, type StrategyConfig, type StrategyDeps, type StrategyStats, type TradeDecision } from '../base-strategy.js';
import { toFraction, type Market } from '../../core/limitless/types.js';

export interface TemplateConfig extends StrategyConfig {
  /** Minimum (fairValue − marketPrice) before buying, 0..1. */
  minEdge: number;
  /** USD per order. Keep it small until the signal is proven. */
  orderUsd: number;
  /** Stop opening new positions past this many. */
  maxPositions: number;
  /** Only markets resolving within this many minutes. */
  maxMinutesToExpiry: number;
}

export class TemplateStrategy extends BaseStrategy {
  private entered = new Set<string>();

  constructor(config: TemplateConfig, deps: StrategyDeps) {
    super(config, deps);
    this.tickIntervalMs = 30_000;
    this.awaitFills = true; // block on taker orders until MINED/killed (honors taker delay)
  }

  async initialize(): Promise<void> {
    const c = this.config as TemplateConfig;
    this.logger.info({ minEdge: c.minEdge, orderUsd: c.orderUsd, maxPositions: c.maxPositions }, 'template initialized');
  }

  async tick(): Promise<TradeDecision[]> {
    const c = this.config as TemplateConfig;
    if (this.entered.size >= c.maxPositions) return [];

    // The API caps `limit` at 25; page for more.
    const markets = await this.limitless.getActiveMarkets({ tradeType: 'clob', limit: 25, sortBy: 'newest' });
    const now = Date.now();
    const decisions: TradeDecision[] = [];

    for (const market of markets) {
      if (this.entered.has(market.slug)) continue;
      const minutesLeft = (market.expirationTimestamp - now) / 60_000;
      if (minutesLeft <= 0 || minutesLeft > c.maxMinutesToExpiry) continue;

      const yesPrice = toFraction(market.prices?.[0]);
      if (yesPrice <= 0 || yesPrice >= 1) continue;

      const fair = this.fairValue(market);
      const edge = fair - yesPrice;
      if (edge < c.minEdge) continue;

      // Take the offer: FOK at a limit a couple of cents above the mid. On a
      // market with a taker delay this comes back DELAYED and the base class
      // waits for the fill because `awaitFills` is on.
      decisions.push({
        action: 'BUY',
        marketSlug: market.slug,
        side: 'YES',
        amountUsd: c.orderUsd,
        priceLimit: Math.min(99, Math.round(yesPrice * 100) + 2),
        orderType: 'FOK',
        reason: `fair ${fair.toFixed(2)} vs market ${yesPrice.toFixed(2)} (edge ${(edge * 100).toFixed(1)}%)`,
      });
      this.entered.add(market.slug);
      if (this.entered.size >= c.maxPositions) break;
    }
    return decisions;
  }

  /**
   * YOUR SIGNAL GOES HERE. This placeholder returns the market's own price,
   * so the edge is always zero and nothing trades — by design. Replace it
   * with something that knows more than the book does.
   */
  protected fairValue(market: Market): number {
    return toFraction(market.prices?.[0]);
  }

  async shutdown(): Promise<void> {
    this.logger.info({ entered: this.entered.size }, 'template shutting down');
  }

  getStats(): StrategyStats {
    return { activePositions: this.entered.size, totalVolumeUsd: 0, pnlUsd: 0, lastTickDurationMs: this.lastTickDurationMs };
  }
}
