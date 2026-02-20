import fetch from 'cross-fetch';
import { pino } from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

export class CoinGeckoClient {
    constructor(
        private baseUrl: string = 'https://api.coingecko.com/api/v3',
        private apiKey?: string // 'x-cg-demo-api-key' usually
    ) {
        this.apiKey = this.apiKey || process.env.COINGECKO_API_KEY;
    }

    private get headers(): Record<string, string> {
        return this.apiKey ? { 'x-cg-demo-api-key': this.apiKey } : {};
    }

    async getPrice(coinId: string, vsCurrency: string = 'usd'): Promise<number> {
        try {
            const url = `${this.baseUrl}/simple/price?ids=${coinId}&vs_currencies=${vsCurrency}&x_cg_demo_api_key=${this.apiKey}`;
            const res = await fetch(url, { headers: this.headers });
            if (!res.ok) {
                if (res.status === 429) logger.warn('CoinGecko rate limit hit');
                return 0;
            }
            const data = await res.json();
            return data[coinId]?.[vsCurrency] || 0;
        } catch (error) {
            logger.error({ error, coinId }, 'Error fetching CoinGecko price');
            return 0;
        }
    }
}
