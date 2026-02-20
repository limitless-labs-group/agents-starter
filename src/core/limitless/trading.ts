import fetch from 'cross-fetch';
import { LimitlessClient } from './markets.js';
import { OrderSigner } from './sign.js';
import { Market, SignedOrder } from './types.js';
import { pino } from 'pino';
import { Hex } from 'viem';

// 1 USDC = 1,000,000 units
const USDC_MULTIPLIER = 1_000_000n;

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

const API_BASE_DEFAULT = 'https://api.limitless.exchange';

export class TradingClient {
    private cachedUserId?: number;
    private marketDetailCache: Map<string, { market: any; fetchedAt: number }> = new Map();
    private readonly MARKET_DETAIL_TTL = 120000; // 2 min
    
    constructor(
        private client: LimitlessClient,
        private signer: OrderSigner,
        private baseUrl: string = process.env.LIMITLESS_API_URL || API_BASE_DEFAULT
    ) { }

    private get headers() {
        const apiKey = process.env.LIMITLESS_API_KEY;
        return {
            'Content-Type': 'application/json',
            ...(apiKey ? { 'X-API-Key': apiKey } : {}),
        };
    }
    
    async getUserId(walletAddress: string): Promise<number> {
        if (this.cachedUserId) return this.cachedUserId;
        
        const url = `${this.baseUrl}/profiles/${walletAddress}`;
        const res = await fetch(url, { headers: this.headers });
        if (!res.ok) throw new Error(`Failed to fetch profile: ${res.status}`);
        const profile = await res.json();
        this.cachedUserId = profile.id;
        logger.info({ userId: profile.id, wallet: walletAddress }, 'Got user profile');
        return profile.id;
    }

    // --- Market Data & Account ---

    async getHistoricalPrice(slug: string, period: '1d' | '1w' | '1m' | 'all' = '1d'): Promise<any> {
        const url = `${this.baseUrl}/markets/${slug}/historical-price?period=${period}`;
        const res = await fetch(url, { headers: this.headers });
        if (!res.ok) throw new Error(`Failed to fetch historical price: ${res.status}`);
        return await res.json();
    }

    async getLockedBalance(slug: string): Promise<{ locked: string }> {
        const url = `${this.baseUrl}/markets/${slug}/locked-balance`;
        const res = await fetch(url, { headers: this.headers });
        if (!res.ok) throw new Error(`Failed to fetch locked balance: ${res.status}`);
        return await res.json();
    }

    async getEvents(slug: string): Promise<any[]> {
        const url = `${this.baseUrl}/markets/${slug}/events`;
        const res = await fetch(url, { headers: this.headers });
        if (!res.ok) throw new Error(`Failed to fetch events: ${res.status}`);
        return await res.json();
    }

    // --- Order Management ---

    async getUserOrders(slug: string, status?: 'OPEN' | 'FILLED' | 'CANCELLED'): Promise<any[]> {
        const params = new URLSearchParams();
        if (status) params.append('statuses', status === 'OPEN' ? 'LIVE' : status); // API uses 'LIVE' instead of 'OPEN'

        // Docs: GET /markets/{slug}/user-orders
        const url = `${this.baseUrl}/markets/${slug}/user-orders?${params.toString()}`;
        const res = await fetch(url, { headers: this.headers });
        if (!res.ok) throw new Error(`Failed to fetch user orders: ${res.status}`);
        return await res.json();
    }

    async createOrder(params: {
        marketSlug: string;
        side: 'YES' | 'NO';
        limitPriceCents: number; // e.g. 50 for 50 cents
        usdAmount: number;       // e.g. 10 for $10
    }): Promise<any> {
        const { marketSlug, side, limitPriceCents, usdAmount } = params;

        // Fetch market details (cached) to get venue and token IDs
        const cached = this.marketDetailCache.get(marketSlug);
        let market: any;
        if (cached && Date.now() - cached.fetchedAt < this.MARKET_DETAIL_TTL) {
            market = cached.market;
        } else {
            market = await this.client.getMarket(marketSlug);
            this.marketDetailCache.set(marketSlug, { market, fetchedAt: Date.now() });
        }
        if (!market.venue) throw new Error(`Market ${marketSlug} has no venue data`);
        // positionIds[0]=YES, positionIds[1]=NO. Some markets imply this differently, 
        // but Limitless standard is usually YES/NO.
        if (!market.positionIds || market.positionIds.length < 2) throw new Error(`Market ${marketSlug} has invalid position IDs`);

        const tokenId = side === 'YES' ? market.positionIds[0] : market.positionIds[1];

        // Calculate amounts with tick alignment
        // Price tick = 0.001 (3 decimals), so contracts must be multiples of 1000
        const price = limitPriceCents / 100; // 0.50
        const TICK_SIZE = 1000n; // contracts must be multiples of this
        const SCALE = 1_000_000n;
        
        // Calculate raw contracts
        const rawContracts = BigInt(Math.floor(usdAmount * 1_000_000 / price));
        
        // Tick-align: round down to nearest TICK_SIZE
        const takerAmount = (rawContracts / TICK_SIZE) * TICK_SIZE;
        
        // Recalculate collateral from tick-aligned contracts
        // makerAmount = contracts * price (in USDC with 6 decimals)
        const priceScaled = BigInt(Math.floor(price * 1_000_000));
        const makerAmount = (takerAmount * priceScaled) / SCALE;
        
        logger.debug({ price, rawContracts, takerAmount, makerAmount }, 'Tick-aligned order amounts');

        // Get user ID for order
        const userId = await this.getUserId(this.signer.getAddress());

        // Sign order
        const signedOrder = await this.signer.signOrder(market.venue, {
            tokenId,
            makerAmount,
            takerAmount,
            side: 'BUY', // Focusing on BUY side for now
        });

        // Submit
        const url = `${this.baseUrl}/orders`;
        logger.info({ slug: marketSlug, side, price, usdAmount }, 'Submitting order');

        // API expects numeric types for amounts, string for expiration
        const body = {
            order: {
                salt: Number(signedOrder.salt),
                maker: signedOrder.maker,
                signer: signedOrder.signer,
                taker: signedOrder.taker,
                tokenId: signedOrder.tokenId,
                makerAmount: Number(signedOrder.makerAmount),
                takerAmount: Number(signedOrder.takerAmount),
                expiration: signedOrder.expiration,  // string "0"
                nonce: signedOrder.nonce,
                feeRateBps: signedOrder.feeRateBps,
                side: signedOrder.side,
                signatureType: signedOrder.signatureType,
                signature: signedOrder.signature,
                price: price,
            },
            orderType: 'GTC',
            marketSlug,
            ownerId: userId,
        };

        if (process.env.DRY_RUN === 'true') {
            logger.info({ slug: marketSlug, body }, 'DRY RUN: Order execution skipped');
            return { status: 'DRY_RUN', order: signedOrder };
        }

        const res = await fetch(url, {
            method: 'POST',
            headers: this.headers,
            body: JSON.stringify(body),
        });

        if (!res.ok) {
            const errText = await res.text();
            throw new Error(`Order submission failed: ${res.status} ${errText}`);
        }

        return await res.json();
    }

    async cancelOrder(orderId: string): Promise<void> {
        const url = `${this.baseUrl}/orders/${orderId}`;
        const res = await fetch(url, {
            method: 'DELETE',
            headers: this.headers,
        });
        if (!res.ok) throw new Error(`Failed to cancel order ${orderId}: ${res.status}`);
    }

    async cancelBatch(orderIds: string[]): Promise<void> {
        const url = `${this.baseUrl}/orders/cancel-batch`;
        const res = await fetch(url, {
            method: 'POST',
            headers: this.headers,
            body: JSON.stringify({ orderIds }),
        });
        if (!res.ok) throw new Error(`Failed to batch cancel: ${res.status}`);
    }

    async cancelAllOrders(marketSlug: string): Promise<void> {
        const url = `${this.baseUrl}/orders/all/${marketSlug}`;
        const res = await fetch(url, {
            method: 'DELETE',
            headers: this.headers,
        });
        if (!res.ok) throw new Error(`Failed to cancel all orders for ${marketSlug}: ${res.status}`);
    }
}
