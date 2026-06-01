/**
 * Per-pair replication loop.
 *
 * Strategy (intentionally dumb):
 *   1. Wait for the WS to push a new quote for the pair's slug.
 *   2. Read latest YES-frame bid/ask.
 *   3. Cancel every open Limitless order on the pair.
 *   4. Place fresh YES-bid + NO-bid BUY orders one margin step inside Poly.
 *
 * Cancel-all + replace every tick. No diff optimizer. The Polymarket book
 * updates a few times a second; cost of cancel+replace is cheaper than
 * the divergence risk of a clever update.
 *
 * Strategy invariants:
 *   - Both Limitless quotes are BUY. We never SELL on Limitless.
 *   - YES_price  = poly_bid - margin
 *   - NO_price   = (1 - poly_ask) - margin
 *   - On shutdown (AbortSignal), cancel-all so we don't leave orphans.
 */

import { pino } from 'pino';
import { SDKTradingClient } from '../../core/limitless/sdk-trading.js';
import type { QuoteFeed } from './quote-feed.js';
import type { Recorder } from './recorder.js';
import type { MarketPair, ReplicatorSettings } from './types.js';

const logger = pino({ level: process.env.LOG_LEVEL || 'info', name: 'cross-market-mm' });

/** Keep prices inside (0, 1) and rounded to Limitless tick (0.001). */
export function clipPrice(p: number): number {
  const rounded = Math.round(p * 1000) / 1000;
  return Math.max(0.001, Math.min(0.999, rounded));
}

/**
 * Pure quote-math primitive — exposed for testing.
 *
 *   YES BUY @ poly_bid - margin
 *   NO  BUY @ (1 - poly_ask) - margin
 *
 * Returns nulls when poly inputs would push a side out of the (0.001, 0.999)
 * range *and* the rounded result equals the boundary — caller decides
 * whether to skip.
 */
export function computeBuyPrices(
  polyBid: number,
  polyAsk: number,
  marginBps: number,
): { yes: number; no: number } {
  const margin = marginBps / 10_000;
  const yes = clipPrice(polyBid - margin);
  const no = clipPrice(1 - polyAsk - margin);
  return { yes, no };
}

async function maybePlace(
  trading: SDKTradingClient,
  pair: MarketPair,
  price: number,
  size: number,
  isYes: boolean,
  recorder?: Recorder,
): Promise<void> {
  // Last-mile range gate. Same shape as the Python `_maybe_place`.
  if (!(price > 0 && price < 1) || size < 1) return;
  try {
    const res = await trading.createOrder({
      marketSlug: pair.limitlessSlug,
      side: isYes ? 'YES' : 'NO',
      limitPriceCents: Math.round(price * 100),
      usdAmount: size * price, // contracts × price = USD notional
      orderType: 'GTC',
      postOnly: true,
    });
    recorder?.record({
      kind: 'order',
      pair: pair.limitlessSlug,
      side: isYes ? 'YES' : 'NO',
      price,
      size,
      orderId: (res as { order?: { id?: string } })?.order?.id,
    });
  } catch (err) {
    logger.warn({ err: (err as Error).message, slug: pair.limitlessSlug }, 'place_order failed');
  }
}

async function replicateOnce(
  pair: MarketPair,
  polyBid: number,
  polyAsk: number,
  trading: SDKTradingClient,
  settings: ReplicatorSettings,
  recorder?: Recorder,
): Promise<void> {
  const { yes: yesPrice, no: noPrice } = computeBuyPrices(polyBid, polyAsk, settings.marginBps);

  // Cancel-all first so the new pair lands on a clean book for our maker.
  await trading.cancelAll(pair.limitlessSlug);

  // Both sides fire concurrently. maybePlace logs (doesn't throw) on rejects
  // so a YES failure doesn't block the NO leg.
  await Promise.all([
    maybePlace(trading, pair, yesPrice, settings.orderSize, true, recorder),
    maybePlace(trading, pair, noPrice, settings.orderSize, false, recorder),
  ]);
}

/**
 * Per-pair task. Loops until the AbortSignal fires; on abort, calls
 * cancelAll once more so we leave Limitless with no resting orders.
 */
export async function runReplicator(
  pair: MarketPair,
  feed: QuoteFeed,
  trading: SDKTradingClient,
  settings: ReplicatorSettings,
  signal: AbortSignal,
  recorder?: Recorder,
): Promise<void> {
  const slug = pair.polymarketSlug;
  feed.ensureSlug(slug);

  logger.info(
    { polymarketSlug: pair.polymarketSlug, limitlessSlug: pair.limitlessSlug },
    'cross-market-mm started',
  );

  let lastRequoteAt = 0;
  try {
    while (!signal.aborted) {
      await feed.nextUpdate(slug, signal);
      if (signal.aborted) break;

      // Re-quote throttle: cancel-replace still fires every cycle, but at most
      // once per minRequoteMs per pair. Poly ticks many times/sec; without this
      // floor a multi-pair run trips the Limitless API rate-limit (429/1015) on
      // sustained operation. We sleep off the remainder, then re-read so we
      // always quote the FRESHEST book — coalescing the burst, not lagging it.
      const sinceLast = Date.now() - lastRequoteAt;
      if (sinceLast < settings.minRequoteMs) {
        await new Promise((r) => setTimeout(r, settings.minRequoteMs - sinceLast));
        if (signal.aborted) break;
      }

      const quote = feed.getQuote(slug);
      if (!quote || quote.bid == null || quote.ask == null) continue;

      lastRequoteAt = Date.now();
      try {
        await replicateOnce(pair, quote.bid, quote.ask, trading, settings, recorder);
      } catch (err) {
        logger.warn({ err: (err as Error).message, slug }, 'replicate tick failed');
        // small backoff so we don't tight-loop on a persistent error
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  } finally {
    // Clean shutdown: cancel everything on this slug AND verify it's gone —
    // a single cancelAll has been seen to leave orders resting. Settle briefly
    // first so any order placed in the final tick has propagated onto the book
    // before we cancel + verify (else it lands after and orphans).
    await new Promise((r) => setTimeout(r, 800));
    try {
      const res = await trading.cancelAllAndVerify(pair.limitlessSlug);
      logger.info(
        { slug: pair.limitlessSlug, remaining: res.remaining },
        'cross-market-mm shutdown: cancelAll verified',
      );
    } catch (err) {
      logger.error(
        { err: (err as Error).message, slug: pair.limitlessSlug },
        'shutdown cancelAll failed — orders may still be resting',
      );
    }
  }
}
