/**
 * flattenBothVenues — sell/redeem all held inventory on Limitless AND
 * Polymarket back to flat. Shared by `replicator:close` (manual) and the bot's
 * shutdown/circuit-breaker path (so a stop never leaves unhedged directional
 * inventory behind).
 *
 * Limitless: FAK SELL at (bid − slippage). Polymarket: market FAK SELL.
 * Uses settled reads + a settle delay so a lagged balance can't trigger a
 * re-sell of what already sold. Idempotent — safe to call repeatedly.
 */

import type { SDKTradingClient } from '../../core/limitless/sdk-trading.js';
import type { LimitlessClient } from '../../core/limitless/markets.js';
import type { PolymarketAdapter } from '../../core/polymarket/client.js';
import type { MarketPair } from './types.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SLIPPAGE_CENTS = 3;
const MIN_SHARES = 0.5;
const MAX_ROUNDS = 4;
const floor3 = (n: number) => Math.floor(n * 1000) / 1000;

export interface VenuePos {
  yes: number;
  no: number;
}
export interface PairFlattenResult {
  slug: string;
  limitless: VenuePos;
  polymarket: VenuePos;
  flat: boolean;
}

async function closeLimitless(
  trading: SDKTradingClient,
  md: LimitlessClient,
  slug: string,
): Promise<VenuePos> {
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const { yes, no } = await trading.getPositionTokensSettled(slug);
    if (yes < MIN_SHARES && no < MIN_SHARES) return { yes, no };

    const ob = (await md.getOrderbook(slug)) as unknown as {
      bids?: Array<{ price: string | number }>;
      asks?: Array<{ price: string | number }>;
    };
    const bids = (ob.bids ?? []).map((l) => Number(l.price)).sort((a, b) => b - a);
    const asks = (ob.asks ?? []).map((l) => Number(l.price)).filter((p) => p < 0.97).sort((a, b) => a - b);
    const yesBid = bids[0] ?? 0.4;
    const yesAsk = asks[0] ?? 0.46;
    const noBid = Math.max(0.02, Math.round((1 - yesAsk) * 100) / 100);

    if (yes >= MIN_SHARES) {
      const px = Math.max(2, Math.round(yesBid * 100) - SLIPPAGE_CENTS);
      await trading
        .sellShares({ marketSlug: slug, side: 'YES', shares: yes, limitPriceCents: px, orderType: 'FAK' })
        .catch(() => {});
      await sleep(2500);
    }
    if (no >= MIN_SHARES) {
      const px = Math.max(2, Math.round(noBid * 100) - SLIPPAGE_CENTS);
      await trading
        .sellShares({ marketSlug: slug, side: 'NO', shares: no, limitPriceCents: px, orderType: 'FAK' })
        .catch(() => {});
      await sleep(2500);
    }
  }
  return trading.getPositionTokensSettled(slug);
}

async function closePolymarket(poly: PolymarketAdapter, pair: MarketPair): Promise<VenuePos> {
  await poly.resolveAssetIds(pair).catch(() => {});
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const pos = (await poly.getPositions([pair])).get(pair.polymarketSlug) ?? { yes: 0, no: 0 };
    if (pos.yes < MIN_SHARES && pos.no < MIN_SHARES) return pos;
    if (pos.yes >= MIN_SHARES && pair.polyYesAssetId) {
      await poly.sellShares(pair.polyYesAssetId, floor3(pos.yes));
      await sleep(6000); // data-api lags after a fill; settle before re-reading
    }
    if (pos.no >= MIN_SHARES && pair.polyNoAssetId) {
      await poly.sellShares(pair.polyNoAssetId, floor3(pos.no));
      await sleep(6000);
    }
  }
  return (await poly.getPositions([pair])).get(pair.polymarketSlug) ?? { yes: 0, no: 0 };
}

/**
 * Cancel resting Limitless orders, then sell inventory on BOTH venues to flat,
 * for every pair. Returns per-pair results; `flat` is true when both venues
 * are below the dust threshold.
 */
export async function flattenBothVenues(
  trading: SDKTradingClient,
  md: LimitlessClient,
  poly: PolymarketAdapter,
  pairs: MarketPair[],
): Promise<PairFlattenResult[]> {
  const results: PairFlattenResult[] = [];
  for (const pair of pairs) {
    await trading.cancelAllAndVerify(pair.limitlessSlug, 8).catch(() => {});
    const limitless = await closeLimitless(trading, md, pair.limitlessSlug);
    const polymarket = await closePolymarket(poly, pair);
    const flat =
      limitless.yes < MIN_SHARES &&
      limitless.no < MIN_SHARES &&
      polymarket.yes < MIN_SHARES &&
      polymarket.no < MIN_SHARES;
    results.push({ slug: pair.polymarketSlug, limitless, polymarket, flat });
  }
  return results;
}
