import fetch from 'cross-fetch';
import { pino } from 'pino';
import { RedeemParams, WithdrawParams } from './types.js';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

const API_BASE = process.env.LIMITLESS_API_URL || 'https://api.limitless.exchange';

// Lazily evaluate headers to ensure env is loaded
function getHeaders(): Record<string, string> {
    const apiKey = process.env.LIMITLESS_API_KEY;
    return {
        'Content-Type': 'application/json',
        ...(apiKey ? { 'X-API-Key': apiKey } : {}),
    };
}

export interface Trade {
    id: string;
    marketId: number;
    strategy: string; // 'Buy' | 'Sell'
    outcome: string;  // 'YES' | 'NO'
    tradeAmount: string;
    tradeAmountUSD: string;
    timestamp: string;
    // ... other fields
}

export interface Position {
    market: {
        title: string;
        slug: string;
        // ...
    };
    positions: {
        yes?: {
            marketValue: string;
            unrealizedPnl: string;
            fillPrice: string;
        };
        no?: {
            marketValue: string;
            unrealizedPnl: string;
            fillPrice: string;
        };
    };
}

export class PortfolioClient {
    constructor(private baseUrl: string = API_BASE) { }

    async getTrades(): Promise<Trade[]> {
        try {
            const url = `${this.baseUrl}/portfolio/trades`;
            logger.debug({ url }, 'Fetching user trades');
            const res = await fetch(url, { headers: getHeaders() });

            if (!res.ok) throw new Error(`Failed to fetch trades: ${res.status}`);
            return await res.json();
        } catch (error) {
            logger.error({ error }, 'Error fetching trades');
            throw error;
        }
    }

    async getPositions(): Promise<Position[]> {
        try {
            const url = `${this.baseUrl}/portfolio/positions`;
            logger.debug({ url }, 'Fetching user positions');
            const res = await fetch(url, { headers: getHeaders() });

            if (!res.ok) throw new Error(`Failed to fetch positions: ${res.status}`);
            // Docs say it returns an object with { clob: [...], amm: [...], ... }
            // We might want to flatten or return raw. Returning raw for now.
            return await res.json();
        } catch (error) {
            logger.error({ error }, 'Error fetching positions');
            throw error;
        }
    }

    async getHistory(page: number = 1, limit: number = 10): Promise<any> {
        try {
            const url = `${this.baseUrl}/portfolio/history?page=${page}&limit=${limit}`;
            const res = await fetch(url, { headers: getHeaders() });
            if (!res.ok) throw new Error(`Failed to fetch history: ${res.status}`);
            return await res.json();
        } catch (error) {
            logger.error({ error }, 'Error fetching history');
            throw error;
        }
    }

    async getAllowance(type: 'clob' | 'negrisk'): Promise<{ allowance: string; spender: string }> {
        try {
            const url = `${this.baseUrl}/portfolio/trading/allowance?type=${type}`;
            const res = await fetch(url, { headers: getHeaders() });
            if (!res.ok) throw new Error(`Failed to fetch allowance: ${res.status}`);
            return await res.json();
        } catch (error) {
            logger.error({ error }, 'Error fetching allowance');
            throw error;
        }
    }

    async getPnlChart(period: '1d' | '1w' | '1m' | 'all' = '1d'): Promise<any> {
        try {
            const url = `${this.baseUrl}/portfolio/pnl-chart?period=${period}`;
            const res = await fetch(url, { headers: getHeaders() });
            if (!res.ok) throw new Error(`Failed to fetch PnL chart: ${res.status}`);
            return await res.json();
        } catch (error) {
            logger.error({ error }, 'Error fetching PnL chart');
            throw error;
        }
    }

    async getPoints(): Promise<any> {
        try {
            const url = `${this.baseUrl}/portfolio/points`;
            const res = await fetch(url, { headers: getHeaders() });
            if (!res.ok) throw new Error(`Failed to fetch points: ${res.status}`);
            return await res.json();
        } catch (error) {
            logger.error({ error }, 'Error fetching points');
            throw error;
        }
    }

    // ─── Server Wallet Redemption & Withdrawal ────────────────────────────
    // These methods call the API endpoints for partner server-wallet sub-accounts.
    // They require scoped API token auth (not legacy X-API-Key).
    // For on-chain CTF redemption (self-signed wallets), see redeem.ts instead.

    /**
     * Redeem resolved positions via the API.
     *
     * Submits `redeemPositions` for a resolved CTF condition. Works for both
     * self-trading accounts and server-wallet sub-accounts (with `onBehalfOf`).
     *
     * **Auth:** Requires `apiToken` auth with `trading` scope. Legacy API keys
     * are NOT supported for server-wallet operations.
     *
     * **Preconditions:**
     * - Market must be resolved
     * - On-chain payout must be posted (`payoutDenominator(conditionId) > 0`)
     * - Position must have redeemable balance
     *
     * @example
     * ```ts
     * const result = await portfolio.redeem({
     *   conditionId: '0xabc123...',
     *   onBehalfOf: subAccountProfileId,
     * });
     * ```
     */
    async redeem(params: RedeemParams): Promise<any> {
        try {
            const url = `${this.baseUrl}/portfolio/redeem`;
            logger.info({ conditionId: params.conditionId, onBehalfOf: params.onBehalfOf }, 'Redeeming resolved position via API');

            const res = await fetch(url, {
                method: 'POST',
                headers: getHeaders(),
                body: JSON.stringify(params),
            });

            if (!res.ok) {
                const errText = await res.text();
                throw new Error(`Failed to redeem: ${res.status} ${errText}`);
            }
            return await res.json();
        } catch (error) {
            logger.error({ error, params }, 'Error redeeming position');
            throw error;
        }
    }

    /**
     * Withdraw ERC20 funds from a managed server-wallet sub-account.
     *
     * Transfers funds from the sub-account's server wallet to the partner's
     * own account or smart wallet.
     *
     * **Auth:** Requires `apiToken` auth with `withdrawal` scope.
     *
     * @example
     * ```ts
     * const result = await portfolio.withdraw({
     *   amount: '50',
     *   token: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // USDC on Base
     *   onBehalfOf: subAccountProfileId,
     * });
     * ```
     */
    async withdraw(params: WithdrawParams): Promise<any> {
        try {
            const url = `${this.baseUrl}/portfolio/withdraw`;
            logger.info({ amount: params.amount, token: params.token, onBehalfOf: params.onBehalfOf }, 'Withdrawing funds via API');

            const res = await fetch(url, {
                method: 'POST',
                headers: getHeaders(),
                body: JSON.stringify(params),
            });

            if (!res.ok) {
                const errText = await res.text();
                throw new Error(`Failed to withdraw: ${res.status} ${errText}`);
            }
            return await res.json();
        } catch (error) {
            logger.error({ error, params }, 'Error withdrawing funds');
            throw error;
        }
    }

    /**
     * Verify whether an order actually filled by checking your live token balance.
     *
     * This is the **ground truth** for fill status. Do not rely solely on
     * `order.execution.matched`, which only reflects immediate matching — later
     * partial fills won't show up there.
     *
     * How it works:
     * 1. Fetches all portfolio positions from the API.
     * 2. Looks for a position matching `marketSlug` and `side`.
     * 3. Reads `tokensBalance` (or equivalent) from that position.
     * 4. Returns `filled: true` if balance > 0.
     *
     * @param marketSlug - The market slug, e.g. `'btc-above-100k'`
     * @param side       - Which outcome token to check: `'YES'` or `'NO'`
     * @returns `{ filled: boolean; balance: bigint }` where `balance` is in raw token units (6 decimals)
     *
     * @example
     * const { filled, balance } = await portfolio.verifyFill('btc-above-100k', 'YES');
     * if (filled) {
     *   console.log(`Order filled! Holding ${Number(balance) / 1e6} contracts`);
     * }
     */
    async verifyFill(
        marketSlug: string,
        side: 'YES' | 'NO',
    ): Promise<{ filled: boolean; balance: bigint }> {
        let raw: any;
        try {
            const url = `${this.baseUrl}/portfolio/positions`;
            const res = await fetch(url, { headers: getHeaders() });
            if (!res.ok) throw new Error(`Failed to fetch positions: ${res.status}`);
            raw = await res.json();
        } catch (error) {
            logger.error({ error, marketSlug, side }, 'Error fetching positions for fill verification');
            throw error;
        }

        // The API may return { clob: [...], amm: [...] } or a flat array.
        // Normalise to a flat list of position objects.
        const positions: any[] = Array.isArray(raw)
            ? raw
            : [
                ...(raw.clob ?? []),
                ...(raw.amm ?? []),
                ...(raw.group ?? []),
            ];

        // Find the position matching our market slug
        const match = positions.find(
            (p: any) => p.market?.slug === marketSlug || p.marketSlug === marketSlug,
        );

        if (!match) {
            logger.debug({ marketSlug, side }, 'No position found for market — order not filled yet');
            return { filled: false, balance: 0n };
        }

        // Extract balance for the requested side.
        // The API may use different field shapes; we try the most common ones.
        const sideData = side === 'YES'
            ? (match.positions?.yes ?? match.yes ?? match.yesPosition)
            : (match.positions?.no  ?? match.no  ?? match.noPosition);

        if (!sideData) {
            return { filled: false, balance: 0n };
        }

        // tokensBalance is the raw ERC-1155 balance (6 decimals for USDC-collateralised markets)
        const rawBalance: string | number | bigint =
            sideData.tokensBalance ?? sideData.balance ?? sideData.size ?? '0';

        const balance = BigInt(Math.round(Number(rawBalance)));

        logger.debug({ marketSlug, side, balance }, 'Fill verification result');

        return { filled: balance > 0n, balance };
    }
}
