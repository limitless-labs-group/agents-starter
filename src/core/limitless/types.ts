/**
 * Shared Limitless types used across strategies.
 *
 * Wire shapes come from the official SDK; this file only re-exports the ones
 * strategies touch and adds the small strategy-level vocabulary (order types,
 * outcome sides) so a strategy never imports the SDK directly for types.
 */

import type {
  Market as SdkMarket,
  OrderBook as SdkOrderBook,
  OrderbookEntry,
  CLOBPosition,
  UserProfile,
  OrderResponse,
  Execution,
} from '@limitless-exchange/sdk';

/** A Limitless market as returned by `GET /markets/:slug` and the listings. */
export type Market = SdkMarket;

/** A CLOB orderbook as returned by `GET /markets/:slug/orderbook`. */
export type Orderbook = SdkOrderBook;

export type { OrderbookEntry, CLOBPosition, UserProfile, OrderResponse, Execution };

/** Supported order execution strategies. */
export type OrderType = 'GTC' | 'FOK' | 'FAK';

/** Binary outcome side. */
export type OutcomeSide = 'YES' | 'NO';

/**
 * YES / NO position token ids for a market. Markets carry them either as
 * `positionIds: [yes, no]` or `tokens: { yes, no }` depending on vintage;
 * always go through {@link marketTokenIds} rather than reading one shape.
 */
export interface MarketTokenIds {
  yes: string;
  no: string;
}

/** Resolve a market's YES/NO token ids, whichever shape the API returned. */
export function marketTokenIds(market: Pick<Market, 'positionIds' | 'tokens' | 'slug'>): MarketTokenIds {
  const yes = market.positionIds?.[0] ?? market.tokens?.yes;
  const no = market.positionIds?.[1] ?? market.tokens?.no;
  if (!yes || !no) {
    throw new Error(`market ${market.slug} has no YES/NO token ids`);
  }
  return { yes, no };
}

/**
 * Normalize a price to the 0..1 range. The markets listing reports `prices`
 * as cents (0..100) while orderbook levels are fractions (0..1); strategies
 * that mix the two should pass everything through this.
 */
export function toFraction(price: number | string | null | undefined): number {
  const v = Number(price ?? 0);
  if (!Number.isFinite(v)) return 0;
  return v > 1 ? v / 100 : v;
}

/**
 * Per-market taker delay in milliseconds (0 = none). FOK/FAK orders on a
 * delayed market come back `DELAYED` with an `eligibleAt`. The SDK's
 * `MarketSettings` type does not model the field yet, hence the cast.
 */
export function takerDelayMs(market: Pick<Market, 'settings'>): number {
  const raw = (market.settings as { takerDelayMs?: number | string } | undefined)?.takerDelayMs;
  const n = Number(raw ?? 0);
  return Number.isFinite(n) ? n : 0;
}
