import fetch from 'cross-fetch';
import crypto from 'crypto';
import { LimitlessClient } from './markets.js';
import { OrderSigner } from './sign.js';
import { Market, SignedOrder } from './types.js';
import { pino } from 'pino';
import { Hex } from 'viem';

// 1 USDC = 1,000,000 units
const USDC_MULTIPLIER = 1_000_000n;

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

const API_BASE_DEFAULT = 'https://api.limitless.exchange';

/** Simple async sleep helper */
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Minimal semaphore for limiting concurrent async operations.
 * Usage: await sem.acquire(); try { ... } finally { sem.release(); }
 */
class Semaphore {
    private queue: (() => void)[] = [];
    private active = 0;
    constructor(private max: number) {}

    acquire(): Promise<void> {
        return new Promise(resolve => {
            if (this.active < this.max) {
                this.active++;
                resolve();
            } else {
                this.queue.push(() => { this.active++; resolve(); });
            }
        });
    }

    release(): void {
        this.active--;
        const next = this.queue.shift();
        if (next) next();
    }
}

export class TradingClient {
    private cachedUserId?: number;
    private marketDetailCache: Map<string, { market: any; fetchedAt: number }> = new Map();
    private readonly MARKET_DETAIL_TTL = 120000; // 2 min

    // --- Rate limiting ---
    /** Timestamp (ms) of the last order submission */
    private lastOrderTime = 0;
    /** Max 2 concurrent order submissions to avoid overwhelming the API */
    private orderSemaphore = new Semaphore(2);

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

        const url = `${this.baseUrl}/markets/${slug}/user-orders?${params.toString()}`;
        const res = await fetch(url, { headers: this.headers });
        if (!res.ok) throw new Error(`Failed to fetch user orders: ${res.status}`);
        return await res.json();
    }

    /**
     * Place a limit order on a market.
     *
     * ## Order types
     *
     * ### GTC (Good-Till-Cancelled) — default
     * - Standard resting limit order that sits in the orderbook until filled or cancelled.
     * - Amount is tick-aligned to the nearest 1000 contracts.
     * - Requires a `price` field in the API body.
     *
     * ### FOK (Fill-Or-Kill)
     * - Executes immediately against the best available liquidity or is fully rejected.
     * - **Critical API gotchas** (the API will reject if you get these wrong):
     *   - `takerAmount` MUST be exactly `1n` — not the number of contracts.
     *   - `makerAmount` = the USD amount you want to spend, in micro-units (e.g. $2 → 2_000_000n).
     *   - Do NOT include a `price` field in the body — the API rejects it.
     *
     * ## Rate limiting
     * - Built-in 300 ms minimum gap between submissions.
     * - Max 2 concurrent in-flight requests.
     *
     * @example GTC order
     * ```ts
     * await trading.createOrder({
     *   marketSlug: 'btc-above-100k',
     *   side: 'YES',
     *   limitPriceCents: 55,
     *   usdAmount: 5,
     *   orderType: 'GTC',
     * });
     * ```
     *
     * @example FOK order ($2 market buy)
     * ```ts
     * await trading.createOrder({
     *   marketSlug: 'btc-above-100k',
     *   side: 'YES',
     *   limitPriceCents: 70,  // your max price ceiling
     *   usdAmount: 2,
     *   orderType: 'FOK',
     * });
     * ```
     */
    async createOrder(params: {
        marketSlug: string;
        side: 'YES' | 'NO';
        /** Limit price in cents, 1–99. E.g. 50 means 50¢ per contract. */
        limitPriceCents: number;
        /** Amount in USD to spend. E.g. 10 means $10. */
        usdAmount: number;
        /** Order type. Defaults to 'GTC'. */
        orderType?: 'GTC' | 'FOK';
    }): Promise<any> {
        const { marketSlug, side, limitPriceCents, usdAmount, orderType = 'FOK' } = params;

        // --- Rate limit: enforce 300 ms gap between order submissions ---
        await this.orderSemaphore.acquire();
        try {
            const waitMs = Math.max(0, 300 - (Date.now() - this.lastOrderTime));
            if (waitMs > 0) {
                logger.debug({ waitMs }, 'Rate limiting: sleeping before order submission');
                await sleep(waitMs);
            }
            return await this._submitOrder({ marketSlug, side, limitPriceCents, usdAmount, orderType });
        } finally {
            this.lastOrderTime = Date.now();
            this.orderSemaphore.release();
        }
    }

    /** Internal: build and submit the order after rate-limit gate */
    private async _submitOrder(params: {
        marketSlug: string;
        side: 'YES' | 'NO';
        limitPriceCents: number;
        usdAmount: number;
        orderType: 'GTC' | 'FOK';
    }): Promise<any> {
        const { marketSlug, side, limitPriceCents, usdAmount, orderType } = params;

        // Fetch market details (cached)
        const cached = this.marketDetailCache.get(marketSlug);
        let market: any;
        if (cached && Date.now() - cached.fetchedAt < this.MARKET_DETAIL_TTL) {
            market = cached.market;
        } else {
            market = await this.client.getMarket(marketSlug);
            this.marketDetailCache.set(marketSlug, { market, fetchedAt: Date.now() });
        }
        if (!market.venue) throw new Error(`Market ${marketSlug} has no venue data`);
        if (!market.positionIds || market.positionIds.length < 2) {
            throw new Error(`Market ${marketSlug} has invalid position IDs`);
        }

        const tokenId = side === 'YES' ? market.positionIds[0] : market.positionIds[1];
        const price = limitPriceCents / 100; // e.g. 0.55

        let makerAmount: bigint;
        let takerAmount: bigint;

        if (orderType === 'FOK') {
            // FOK gotchas:
            //   - takerAmount MUST be exactly 1n (API requirement, not a contract count)
            //   - makerAmount = USD spend in micro-units (1 USD = 1_000_000)
            //   - price field must NOT be included in the body
            makerAmount = BigInt(Math.round(usdAmount * 1_000_000));
            takerAmount = 1n;
            logger.debug({ usdAmount, makerAmount, takerAmount }, 'FOK order amounts (takerAmount fixed at 1)');
        } else {
            // GTC: standard tick-aligned contract calculation
            // Price tick = 0.001 (3 decimals), so contracts must be multiples of 1000
            const TICK_SIZE = 1000n;
            const SCALE = 1_000_000n;

            const rawContracts = BigInt(Math.floor(usdAmount * 1_000_000 / price));
            // Tick-align: round down to nearest TICK_SIZE
            takerAmount = (rawContracts / TICK_SIZE) * TICK_SIZE;

            // Recalculate collateral from tick-aligned contracts
            const priceScaled = BigInt(Math.floor(price * 1_000_000));
            makerAmount = (takerAmount * priceScaled) / SCALE;

            logger.debug({ price, rawContracts, takerAmount, makerAmount }, 'GTC tick-aligned order amounts');
        }

        // Get user ID and sign the order
        const userId = await this.getUserId(this.signer.getAddress());

        const signedOrder = await this.signer.signOrder(market.venue, {
            tokenId,
            makerAmount,
            takerAmount,
            side: 'BUY',
        });

        // Build request body — FOK must NOT include price
        const orderBody: Record<string, any> = {
            order: {
                salt: Number(signedOrder.salt),
                maker: signedOrder.maker,
                signer: signedOrder.signer,
                taker: signedOrder.taker,
                tokenId: signedOrder.tokenId,
                makerAmount: Number(signedOrder.makerAmount),
                takerAmount: Number(signedOrder.takerAmount),
                expiration: signedOrder.expiration,
                nonce: signedOrder.nonce,
                feeRateBps: signedOrder.feeRateBps,
                side: signedOrder.side,
                signatureType: signedOrder.signatureType,
                signature: signedOrder.signature,
                // GTC includes price; FOK must NOT
                ...(orderType === 'GTC' ? { price } : {}),
            },
            orderType,
            marketSlug,
            ownerId: userId,
            clientOrderId: `${marketSlug}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
        };

        const url = `${this.baseUrl}/orders`;
        logger.info({ slug: marketSlug, side, price, usdAmount, orderType, clientOrderId: orderBody.clientOrderId }, 'Submitting order');

        if (process.env.DRY_RUN === 'true') {
            logger.info({ slug: marketSlug, body: orderBody }, 'DRY RUN: Order execution skipped');
            return { status: 'DRY_RUN', order: signedOrder };
        }

        const res = await fetch(url, {
            method: 'POST',
            headers: this.headers,
            body: JSON.stringify(orderBody),
        });

        if (!res.ok) {
            const errText = await res.text();

            // Detect approval-related errors and surface a helpful message.
            // Common signatures from the CTF exchange / ERC-20 contracts:
            //   "insufficient allowance", "ERC20: insufficient allowance",
            //   "not approved", "approval", "allowance"
            const lowerErr = errText.toLowerCase();
            const isApprovalIssue =
                lowerErr.includes('allowance') ||
                lowerErr.includes('not approved') ||
                lowerErr.includes('approval') ||
                lowerErr.includes('insufficient') ||
                res.status === 403;

            if (isApprovalIssue) {
                throw new Error(
                    `Market not approved. Run: npm start approve ${marketSlug}\n` +
                    `  (Original error: ${res.status} ${errText})`
                );
            }

            throw new Error(`Order submission failed [${orderType}]: ${res.status} ${errText}`);
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
