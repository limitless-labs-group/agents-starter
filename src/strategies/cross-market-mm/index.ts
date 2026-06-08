/**
 * Per-pair replication loop.
 *
 * Strategy:
 *   1. Wait for the WS to push a new Poly quote for the pair's slug.
 *   2. Read latest YES-frame Poly bid/ask (the fair value to hedge against).
 *   3. Fetch the Limitless book so we quote competitively, not blind.
 *   4. Cancel every open Limitless order on the pair.
 *   5. Place fresh YES-bid + NO-bid BUY orders: as aggressive as profitable,
 *      capped at fair value, one tick inside the resting Limitless book.
 *
 * Cancel-all + replace every tick. No diff optimizer.
 *
 * Strategy invariants:
 *   - Both Limitless quotes are BUY. We never SELL on Limitless.
 *   - Prices are quantized to the venue tick (whole cents). The order API takes
 *     integer-cent prices, so a margin finer than one cent is a no-op.
 *   - Fair-value cap (the safety net): YES_buy <= poly_bid - margin and
 *     NO_buy <= (1 - poly_ask) - margin, so any fill is hedgeable at a profit.
 *     The Limitless book only ever makes us MORE competitive UP TO that cap; an
 *     empty or misread book degrades to fair-value-only quoting, never to an
 *     unprofitable quote.
 *   - On shutdown (AbortSignal), cancel-all so we don't leave orphans.
 */

import fs from 'node:fs';
import { pino } from 'pino';
import { SDKTradingClient } from '../../core/limitless/sdk-trading.js';
import type { LimitlessClient } from '../../core/limitless/markets.js';
import type { Orderbook } from '../../core/limitless/types.js';
import type { QuoteFeed } from './quote-feed.js';
import type { Recorder } from './recorder.js';
import type { MarketPair, ReplicatorSettings } from './types.js';

const logger = pino({ level: process.env.LOG_LEVEL || 'info', name: 'cross-market-mm' });

/** Limitless order price granularity: the order API takes whole-cent prices. */
export const TICK = 0.01;

/** Keep prices on the cent grid and inside [TICK, 1 - TICK]. */
export function clipPrice(p: number): number {
  const rounded = Math.round(p * 100) / 100;
  return Math.max(TICK, Math.min(1 - TICK, rounded));
}

/** Orderbook prices may arrive as 0-1 fractions or 0-100 cents; normalize to 0-1. */
export function normPrice(p: number): number {
  return p > 1 ? p / 100 : p;
}

export interface BookTop {
  bid: number | null;
  ask: number | null;
}

/** Best YES bid/ask from a Limitless orderbook, normalized to 0-1. Nulls when empty. */
export function bookTop(book: Orderbook | null | undefined): BookTop {
  if (!book) return { bid: null, ask: null };
  const norm = (levels: Array<{ price: string | number }> | undefined): number[] =>
    (levels ?? [])
      .map((l) => normPrice(Number(l.price)))
      .filter((n) => Number.isFinite(n) && n > 0 && n < 1);
  const bids = norm(book.bids);
  const asks = norm(book.asks);
  return {
    bid: bids.length ? Math.max(...bids) : null,
    ask: asks.length ? Math.min(...asks) : null,
  };
}

/**
 * Pure quote-math primitive, exposed for testing.
 *
 * Fair value (from Poly) caps how high we buy so a fill stays hedgeable:
 *   YES_buy <= poly_bid - margin
 *   NO_buy  <= (1 - poly_ask) - margin
 * The Limitless YES book, when present, makes us as competitive as profitable:
 * one tick inside the resting book so we rest as a maker (never cross), but
 * never above the cap. A missing book falls back to fair value. Prices are
 * quantized to whole cents.
 */
export function computeBuyPrices(
  polyBid: number,
  polyAsk: number,
  marginBps: number,
  yesBook?: BookTop,
): { yes: number; no: number } {
  const margin = marginBps / 10_000;
  const fairYes = polyBid - margin;
  const fairNo = 1 - polyAsk - margin;

  // The cap is the safety net. The book can only lower (never raise) the quote,
  // so even a bad book read can't push us above fair value.
  let yes = fairYes;
  let no = fairNo;
  if (yesBook?.ask != null) yes = Math.min(fairYes, yesBook.ask - TICK); // rest below the YES ask
  if (yesBook?.bid != null) no = Math.min(fairNo, 1 - yesBook.bid - TICK); // NO buy == YES sell; rest above the YES bid

  return { yes: clipPrice(yes), no: clipPrice(no) };
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
  markets: LimitlessClient | undefined,
  recorder?: Recorder,
): Promise<void> {
  // Read the Limitless book so we quote competitively. Best-effort: a failed
  // fetch degrades to fair-value-only quoting (the prior behavior), never blocks.
  let yesBook: BookTop | undefined;
  if (markets) {
    try {
      yesBook = bookTop(await markets.getOrderbook(pair.limitlessSlug));
    } catch {
      yesBook = undefined;
    }
  }

  const { yes: yesPrice, no: noPrice } = computeBuyPrices(
    polyBid,
    polyAsk,
    settings.marginBps,
    yesBook,
  );

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
  markets: LimitlessClient,
  settings: ReplicatorSettings,
  signal: AbortSignal,
  recorder?: Recorder,
  pullFlagPath?: string,
): Promise<void> {
  const slug = pair.polymarketSlug;
  feed.ensureSlug(slug);
  let pulled = false; // pull.flag latch: cancel quotes once on entering "pulled"

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

      // pull.flag: pause quoting WITHOUT halting. Cancel resting quotes once on
      // entering the pulled state and stop placing new ones; the hedger task is
      // separate and keeps managing inventory. Resumes when the flag clears.
      if (pullFlagPath && fs.existsSync(pullFlagPath)) {
        if (!pulled) {
          pulled = true;
          await trading.cancelAllAndVerify(pair.limitlessSlug).catch(() => {});
          logger.warn({ slug }, 'quotes pulled (pull.flag present) — holding; hedger still manages inventory');
        }
        continue;
      }
      pulled = false;

      const quote = feed.getQuote(slug);
      if (!quote || quote.bid == null || quote.ask == null) continue;

      lastRequoteAt = Date.now();
      try {
        await replicateOnce(pair, quote.bid, quote.ask, trading, settings, markets, recorder);
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
