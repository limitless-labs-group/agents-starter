/**
 * certainty-closer — a deliberately simple, SDK-only example strategy.
 *
 * The idea: near a market's resolution, one side is often already "obvious"
 * (trading at, say, 0.92). This buys a small position in that leading side,
 * betting it closes where it's pointing. It teaches the two things every
 * Limitless strategy needs — filtering markets by time-to-expiry, and the
 * BaseStrategy tick→decision→execute loop — using **only** the Limitless SDK
 * (no external price feeds).
 *
 * HONEST FRAMING (read before trusting it with money): on its own this has **no
 * independent edge**. Buying the favourite at 0.92 wins 0.08 when you're right
 * and loses 0.92 when the "obvious" outcome flips — the crowd is usually right,
 * but the payoff is thin and one upset erases many wins. The only edge here is
 * the one YOU assert via `assumedEdge`: how much more certain than the market
 * you believe the near-resolution outcome is. Set it to 0 and the Kelly sizer
 * correctly refuses to bet. To make this real, replace the `assumedEdge`
 * guess with an actual signal (an oracle/data read confirming the outcome).
 *
 * Sizing uses the shared `kelly-lite` util so the bet scales to your asserted
 * edge with a hard cap, instead of a flat stake.
 */

import { BaseStrategy, StrategyConfig, TradeDecision } from '../base-strategy.js';
import { kellySize } from '../../core/kelly.js';

export interface CertaintyCloserConfig extends StrategyConfig {
  /** Only consider markets whose leading side is at least this price (0..1). */
  minLeadPrice: number;
  /** ...and at most this — above it the return is too thin to bother. */
  maxLeadPrice: number;
  /** Only markets resolving within this many minutes. */
  maxMinutesToExpiry: number;
  /** ...and not sooner than this (0 = right up to expiry). */
  minMinutesToExpiry: number;
  /** YOUR asserted edge over the market on the leading side (0..1). 0 = won't bet. */
  assumedEdge: number;
  /** Bankroll the Kelly sizer sizes against, USD. */
  bankrollUsd: number;
  /** Kelly multiplier (0.25 = quarter-Kelly, safer). */
  kellyFraction: number;
  /** Hard cap on dollars risked per bet. */
  maxRiskUsd: number;
  /** Max concurrent positions before we stop opening new ones. */
  maxPositions: number;
}

interface MarketLike {
  slug: string;
  title?: string;
  tradeType?: string;
  prices?: number[];
  expirationTimestamp?: number;
}

/** Normalize a price to 0..1 — the markets API has returned both 0..1 and 0..100. */
function norm(p: number | undefined): number {
  const v = Number(p ?? 0);
  return v > 1 ? v / 100 : v;
}

export class CertaintyCloserStrategy extends BaseStrategy {
  private traded = new Set<string>();

  constructor(
    config: StrategyConfig,
    deps: ConstructorParameters<typeof BaseStrategy>[1],
  ) {
    super(config, deps);
    this.tickIntervalMs = 30_000; // near-expiry markets move; re-scan every 30s
  }

  async initialize(): Promise<void> {
    const c = this.config as CertaintyCloserConfig;
    this.logger.info(
      {
        leadRange: `${c.minLeadPrice}–${c.maxLeadPrice}`,
        window: `${c.minMinutesToExpiry}–${c.maxMinutesToExpiry}m`,
        assumedEdge: c.assumedEdge,
        kelly: `${(c.kellyFraction * 100).toFixed(0)}%`,
      },
      'Certainty Closer initialized',
    );
    if (c.assumedEdge <= 0) {
      this.logger.warn(
        'assumedEdge is 0 → the Kelly sizer will refuse every bet (no edge). Set it > 0, or wire a real signal.',
      );
    }
  }

  async tick(): Promise<TradeDecision[]> {
    const c = this.config as CertaintyCloserConfig;
    const decisions: TradeDecision[] = [];
    if (this.traded.size >= c.maxPositions) return decisions;

    // The markets API caps `limit` at 25; scan the most recent active CLOB
    // markets (sorted newest — short-window markets surface here).
    const markets = (await this.limitless.getActiveMarkets({
      tradeType: 'clob',
      limit: 25,
    })) as unknown as MarketLike[];

    const now = Date.now();
    for (const m of markets) {
      if (m.tradeType !== 'clob' || !m.slug || this.traded.has(m.slug)) continue;
      if (!m.expirationTimestamp) continue;

      const minsToExpiry = (m.expirationTimestamp - now) / 60_000;
      if (minsToExpiry < c.minMinutesToExpiry || minsToExpiry > c.maxMinutesToExpiry) continue;

      const yes = norm(m.prices?.[0]);
      const no = norm(m.prices?.[1]);
      // The "obvious" side = whichever is the favourite.
      const side: 'YES' | 'NO' = yes >= no ? 'YES' : 'NO';
      const price = side === 'YES' ? yes : no;
      if (price < c.minLeadPrice || price > c.maxLeadPrice) continue;

      // The only edge is the one you assert. trueProb = price + your assumedEdge.
      const trueProb = Math.min(0.999, price + c.assumedEdge);
      const sized = kellySize({
        trueProb,
        price,
        bankrollUsd: c.bankrollUsd,
        fraction: c.kellyFraction,
        maxRiskUsd: c.maxRiskUsd,
      });
      if (sized.riskUsd <= 0 || sized.shares <= 0) continue;

      this.logger.info(
        { market: m.slug, side, price, minsToExpiry: minsToExpiry.toFixed(1), risk: sized.riskUsd.toFixed(2) },
        'certainty candidate',
      );
      decisions.push({
        action: 'BUY',
        marketSlug: m.slug,
        side,
        amountUsd: sized.riskUsd,
        // Cross up to a couple cents to take the offer; clamp to <100.
        priceLimit: Math.min(99, Math.round(price * 100) + 2),
        orderType: 'FOK',
        reason: `near-resolution favourite ${side}@${price.toFixed(2)}, ${minsToExpiry.toFixed(0)}m to expiry — ${sized.reason}`,
      });
      this.traded.add(m.slug);
      if (this.traded.size >= c.maxPositions) break;
    }
    return decisions;
  }

  async shutdown(): Promise<void> {
    this.logger.info({ traded: this.traded.size }, 'Certainty Closer shutting down');
  }

  getStats() {
    return { activePositions: this.traded.size, totalVolumeUsd: 0, pnlUsd: 0, lastTickDurationMs: 0 };
  }
}
