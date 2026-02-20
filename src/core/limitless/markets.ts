import fetch from 'cross-fetch';
import { Market, MarketDetail, Orderbook } from './types.js';
import { pino } from 'pino';

// Using a module-level logger for now, ideally passed in via constructor
const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

const API_BASE = process.env.LIMITLESS_API_URL || 'https://api.limitless.exchange';

// Build headers lazily to ensure env vars are loaded
function getHeaders() {
    const apiKey = process.env.LIMITLESS_API_KEY;
    if (!apiKey) {
        logger.warn('LIMITLESS_API_KEY is not set. Some endpoints may fail.');
    }
    return {
        'Content-Type': 'application/json',
        ...(apiKey ? { 'X-API-Key': apiKey } : {}),
    };
}

export class LimitlessClient {
    private venueCache: Map<string, Market['venue']> = new Map();

    constructor(private baseUrl: string = API_BASE) { }

    async getActiveMarkets(options: {
        category?: number;
        tradeType?: 'amm' | 'clob' | 'group';
        limit?: number;
        offset?: number;
    } = {}): Promise<Market[]> {
        const params = new URLSearchParams();
        if (options.category) params.append('category', options.category.toString());
        if (options.tradeType) params.append('tradeType', options.tradeType);
        if (options.limit) params.append('limit', options.limit.toString());
        if (options.offset) params.append('offset', options.offset.toString());

        try {
            // Docs say: GET /markets/active
            const url = `${this.baseUrl}/markets/active?${params.toString()}`;
            logger.debug({ url }, 'Fetching active markets');
            const res = await fetch(url, { headers: getHeaders() });

            if (!res.ok) {
                throw new Error(`Failed to fetch markets: ${res.status} ${res.statusText}`);
            }

            const data = await res.json();
            // Docs response: { data: [ ...markets... ], totalMarketsCount: 150 }
            const markets = data.data || [];

            // Cache venues
            markets.forEach((m: Market) => {
                if (m.slug && m.venue) {
                    this.venueCache.set(m.slug, m.venue);
                }
            });

            // Normalize markets (map tokens -> positionIds)
            return markets.map((m: any) => ({
                ...m,
                positionIds: m.tokens ? [m.tokens.yes, m.tokens.no] : m.positionIds
            }));
        } catch (error) {
            logger.error({ error }, 'Error fetching active markets');
            throw error;
        }
    }

    async searchMarkets(query: string, options: {
        similarityThreshold?: number;
        limit?: number;
        page?: number;
    } = {}): Promise<Market[]> {
        const params = new URLSearchParams();
        params.append('query', query);
        if (options.similarityThreshold) params.append('similarityThreshold', options.similarityThreshold.toString());
        if (options.limit) params.append('limit', options.limit.toString());
        if (options.page) params.append('page', options.page.toString());

        try {
            const url = `${this.baseUrl}/markets/search?${params.toString()}`;
            logger.debug({ url, query }, 'Searching markets');
            const res = await fetch(url, { headers: getHeaders() });

            if (!res.ok) {
                throw new Error(`Failed to search markets: ${res.status} ${res.statusText}`);
            }

            // Docs: Returns markets matching the search query
            const data = await res.json();
            // Response format: { markets: [...], totalMarketsCount: N }
            const markets = Array.isArray(data) ? data : (data.markets || data.data || []);

            // Cache venues if present
            markets.forEach((m: Market) => {
                if (m.slug && m.venue) {
                    this.venueCache.set(m.slug, m.venue);
                }
            });

            return markets;
        } catch (error) {
            logger.error({ error, query }, 'Error searching markets');
            throw error;
        }
    }

    async getMarket(slug: string): Promise<MarketDetail> {
        try {
            const url = `${this.baseUrl}/markets/${slug}`;
            logger.debug({ url }, 'Fetching market detail');
            const res = await fetch(url, { headers: getHeaders() });

            if (!res.ok) {
                throw new Error(`Failed to fetch market ${slug}: ${res.status} ${res.statusText}`);
            }

            const market = await res.json() as MarketDetail;

            if (market.venue) {
                this.venueCache.set(slug, market.venue);
            }

            // Normalize
            if ((market as any).tokens && !market.positionIds) {
                market.positionIds = [(market as any).tokens.yes, (market as any).tokens.no];
            }

            // Normalize
            if ((market as any).tokens && !market.positionIds) {
                market.positionIds = [(market as any).tokens.yes, (market as any).tokens.no];
            }

            return market;

        } catch (error) {
            logger.error({ error, slug }, 'Error fetching market detail');
            throw error;
        }
    }

    async getOrderbook(slug: string): Promise<Orderbook> {
        // Determine strict URL for orderbook. Usually /markets/:slug/orderbook or similar
        // Based on user prompt: "GET /markets/{slug}/orderbook"
        try {
            const url = `${this.baseUrl}/markets/${slug}/orderbook`;
            const res = await fetch(url, { headers: getHeaders() });

            if (!res.ok) {
                throw new Error(`Failed to fetch orderbook for ${slug}`);
            }

            return await res.json() as Orderbook;
        } catch (error) {
            logger.error({ error, slug }, 'Error fetching orderbook');
            throw error;
        }
    }

    async getMarketsByCategoryId(categoryId: number, options: {
        limit?: number;
        offset?: number;
    } = {}): Promise<Market[]> {
        return this.getActiveMarkets({ category: categoryId, ...options });
    }

    async getCategoriesCount(): Promise<Record<string, number>> {
        try {
            const url = `${this.baseUrl}/markets/categories/count`;
            const res = await fetch(url, { headers: getHeaders() });
            if (!res.ok) throw new Error(`Failed to fetch category counts: ${res.status}`);
            return await res.json();
        } catch (error) {
            logger.error({ error }, 'Error fetching category counts');
            throw error;
        }
    }

    async getSlugs(): Promise<string[]> {
        try {
            const url = `${this.baseUrl}/markets/active/slugs`;
            const res = await fetch(url, { headers: getHeaders() });
            if (!res.ok) throw new Error(`Failed to fetch slugs: ${res.status}`);
            return await res.json();
        } catch (error) {
            logger.error({ error }, 'Error fetching slugs');
            throw error;
        }
    }

    async getFeedEvents(slug: string): Promise<any[]> {
        try {
            const url = `${this.baseUrl}/markets/${slug}/get-feed-events`;
            const res = await fetch(url, { headers: getHeaders() });
            if (!res.ok) throw new Error(`Failed to fetch feed events: ${res.status}`);
            return await res.json();
        } catch (error) {
            logger.error({ error, slug }, 'Error fetching feed events');
            throw error;
        }
    }

    // Helper to get venue directly from cache or fetch
    async getVenue(slug: string): Promise<Market['venue']> {
        if (this.venueCache.has(slug)) {
            return this.venueCache.get(slug)!;
        }
        const market = await this.getMarket(slug);
        return market.venue;
    }
}
