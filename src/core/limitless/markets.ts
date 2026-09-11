/**
 * LimitlessClient — market discovery, detail, and orderbook reads.
 *
 * A thin wrapper over the official SDK's `Client`. Typed reads go through the
 * SDK services (`sdk.markets.getMarket`, `sdk.markets.getOrderBook`); the few
 * list/search endpoints the SDK does not model yet go through the SDK's
 * `HttpClient` so they still get HMAC signing, retries, and the same base URL.
 *
 * All methods return the SDK `Market` / `OrderBook` shapes. Position token ids
 * are normalized so `positionIds` is always present alongside `tokens`.
 */

import type { Client } from '@limitless-exchange/sdk';
import { pino } from 'pino';
import { createSdkClient, type LimitlessClientOptions } from './client.js';
import type { Market, Orderbook } from './types.js';

const logger = pino({ level: process.env.LOG_LEVEL || 'info', name: 'limitless-markets' });

/** `GET /markets/active` query. The API caps `limit` at 25; paginate with `page` (1-indexed). */
export interface ActiveMarketsOptions {
  category?: number;
  tradeType?: 'amm' | 'clob' | 'group';
  automationType?: 'manual' | 'lumy' | 'sports';
  limit?: number;
  page?: number;
  sortBy?: 'newest' | 'ending_soon' | 'high_value' | 'lp_rewards' | 'trending';
}

export interface SearchMarketsOptions {
  /** Minimum semantic similarity, 0..1. API default 0.5. */
  similarityThreshold?: number;
  limit?: number;
  page?: number;
}

/** Ensure `positionIds` mirrors `tokens` (and vice versa) on a market. */
export function normalizeMarket<T extends Partial<Market>>(market: T): T {
  if (!market) return market;
  if (!market.positionIds && market.tokens?.yes && market.tokens?.no) {
    market.positionIds = [market.tokens.yes, market.tokens.no];
  }
  if (!market.tokens && market.positionIds?.length === 2) {
    market.tokens = { yes: market.positionIds[0], no: market.positionIds[1] };
  }
  return market;
}

export class LimitlessClient {
  /** The underlying SDK client, for anything not wrapped here. */
  readonly sdk: Client;
  private readonly venueCache = new Map<string, NonNullable<Market['venue']>>();

  constructor(sdkOrOptions: Client | LimitlessClientOptions = {}) {
    this.sdk = isSdkClient(sdkOrOptions) ? sdkOrOptions : createSdkClient(sdkOrOptions);
  }

  /**
   * Active markets. Mirrors `GET /markets/active` including the `tradeType`
   * and `category` filters the SDK's typed `getActiveMarkets` does not expose.
   */
  async getActiveMarkets(options: ActiveMarketsOptions = {}): Promise<Market[]> {
    const params: Record<string, string | number> = {};
    if (options.category) params.category = options.category;
    if (options.tradeType) params.tradeType = options.tradeType;
    if (options.automationType) params.automationType = options.automationType;
    if (options.limit) params.limit = options.limit;
    if (options.page) params.page = options.page;
    if (options.sortBy) params.sortBy = options.sortBy;

    const path = options.category ? `/markets/active/${options.category}` : '/markets/active';
    const res = await this.sdk.http.get<{ data?: Market[] } | Market[]>(path, { params });
    const markets = Array.isArray(res) ? res : (res?.data ?? []);
    return markets.map((m) => this.remember(normalizeMarket(m)));
  }

  /** Semantic search (`GET /markets/search`). */
  async searchMarkets(query: string, options: SearchMarketsOptions = {}): Promise<Market[]> {
    const params: Record<string, string | number> = { query };
    if (options.similarityThreshold) params.similarityThreshold = options.similarityThreshold;
    if (options.limit) params.limit = options.limit;
    if (options.page) params.page = options.page;

    const res = await this.sdk.http.get<Market[] | { markets?: Market[]; data?: Market[] }>(
      '/markets/search',
      { params },
    );
    const markets = Array.isArray(res) ? res : (res?.markets ?? res?.data ?? []);
    return markets.map((m) => this.remember(normalizeMarket(m)));
  }

  /**
   * Short-window price markets for an asset (the recurring hourly/daily
   * up/down markets), expiring within the next 60 minutes.
   */
  async searchHourlyMarkets(asset: string): Promise<Market[]> {
    const results = await this.searchMarkets(`${asset.toUpperCase()} above`, { limit: 50 });
    const now = Date.now();
    const hour = 60 * 60 * 1000;
    return results.filter((m) => {
      if (m.automationType && m.automationType !== 'lumy') return false;
      if (!m.expirationTimestamp) return false;
      const left = m.expirationTimestamp - now;
      return left > 0 && left <= hour;
    });
  }

  /** Market detail (`GET /markets/:slug`), via the SDK's typed fetcher. */
  async getMarket(slug: string): Promise<Market> {
    const market = normalizeMarket(await this.sdk.markets.getMarket(slug));
    return this.remember(market);
  }

  /** CLOB orderbook (`GET /markets/:slug/orderbook`). Prices are 0..1 fractions. */
  async getOrderbook(slug: string): Promise<Orderbook> {
    return this.sdk.markets.getOrderBook(slug);
  }

  /** All active market slugs (`GET /markets/active/slugs`). */
  async getSlugs(): Promise<string[]> {
    return this.sdk.http.get<string[]>('/markets/active/slugs');
  }

  /** Category → active market count (`GET /markets/categories/count`). */
  async getCategoriesCount(): Promise<Record<string, number>> {
    return this.sdk.http.get<Record<string, number>>('/markets/categories/count');
  }

  /** Venue (exchange + adapter addresses) for a market, cached per slug. */
  async getVenue(slug: string): Promise<NonNullable<Market['venue']>> {
    const cached = this.venueCache.get(slug);
    if (cached) return cached;
    const market = await this.getMarket(slug);
    if (!market.venue) throw new Error(`market ${slug} has no venue data`);
    return market.venue;
  }

  private remember(market: Market): Market {
    if (market?.slug && market.venue) this.venueCache.set(market.slug, market.venue);
    logger.trace({ slug: market?.slug }, 'market cached');
    return market;
  }
}

function isSdkClient(value: Client | LimitlessClientOptions): value is Client {
  return typeof (value as Client).markets?.getMarket === 'function';
}
