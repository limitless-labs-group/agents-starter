import fetch from 'cross-fetch';
import { pino } from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

const API_BASE = process.env.LIMITLESS_API_URL || 'https://api.limitless.exchange';
const API_KEY = process.env.LIMITLESS_API_KEY;

if (!API_KEY) {
    logger.warn('LIMITLESS_API_KEY is not set. Portfolio endpoints will fail.');
}

const headers = {
    'Content-Type': 'application/json',
    ...(API_KEY ? { 'X-API-Key': API_KEY } : {}),
};

export interface Trade {
    id: string;
    marketId: number;
    strategy: string; // 'Buy' | 'Sell'
    outcome: string; // 'YES' | 'NO'
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
            const res = await fetch(url, { headers });

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
            const res = await fetch(url, { headers });

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
            const res = await fetch(url, { headers });
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
            const res = await fetch(url, { headers });
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
            const res = await fetch(url, { headers });
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
            const res = await fetch(url, { headers });
            if (!res.ok) throw new Error(`Failed to fetch points: ${res.status}`);
            return await res.json();
        } catch (error) {
            logger.error({ error }, 'Error fetching points');
            throw error;
        }
    }
}
