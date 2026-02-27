import { EventEmitter } from 'events';
import { pino } from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

/**
 * Hermes Pyth price feed via Server-Sent Events (SSE)
 * 
 * This provides sub-second oracle prices for crypto assets.
 * Hermes is the Pyth network's streaming service.
 * 
 * Base URL: https://hermes.pyth.network/v2/updates/price/stream
 */

// Pyth price feed IDs for common assets
// Source: https://pyth.network/developers/price-feed-ids
const PRICE_FEED_IDS: Record<string, string> = {
    'BTC': 'e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43',
    'ETH': 'ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace',
    'SOL': 'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d',
    'DOGE': 'dcef50d57b43602ae68ad57797fc276968be4f9ee7297f5d77c1f451e8dd6781',
    'AVAX': '93da3352f9f1d105fdfe4971cfa80e9dd777bfc5d0f683ebb6e1294b92137bb7',
    'ARB': '3fa4252848f9f0a1480be62745a4629d0eb8d4cd567c89de06b3f0f6b64c9cd7',
    'OP': '385deb74d28bde50df408a98d4bb6a6e2457431955de8c0c6f5433ca3c8d2d7f',
    'MATIC': '5de33a9112c2b700b8d30e9aa21b72a3f51d552c626a7e8aa7fc6f1266f67373',
    'LINK': 'c59e0c1b620618d7dd4ff1c6ac2b4175b4e59b003f5a2bd8f8c245a6f07cb578',
    'UNI': '78d185a741d07edb3412b09008b7c76424bc6ac8d9b3a37f9a89c1c60019e51a',
    'AAVE': '2b9ab1e972a281585084148b138cb47e24c4455b42a9489957744a9916e457e0',
    'MKR': '5969cd3e28c1fbcf35d3f8194a790bf7939de0f8e8713ff14a54c2d1fb66926a',
    'LTC': '6e3f3fa3cca9495c2a9479370542010e3e8eb793b9640525ae4f6f01c05b765f',
    'BCH': '5fccd82db8fea537349ee498a0c5b7d8c4c0413d1d6df27eb87b2c5aa8b4d92c',
};

// Streamed price update from Hermes
interface PriceUpdate {
    id: string;
    price: {
        price: string;
        conf: string;
        expo: number;
        publish_time: number;
    };
    ema_price?: {
        price: string;
        conf: string;
        expo: number;
        publish_time: number;
    };
}

export class HermesClient extends EventEmitter {
    private eventSource: EventSource | null = null;
    private prices: Map<string, { price: number; timestamp: number; conf: number }> = new Map();
    private connected = false;
    private reconnectTimer: NodeJS.Timeout | null = null;
    private readonly baseUrl = 'https://hermes.pyth.network/v2/updates/price/stream';

    constructor() {
        super();
    }

    /**
     * Start streaming prices for given assets
     * @param assets Array of asset symbols (e.g., ['BTC', 'ETH'])
     */
    async connect(assets: string[]): Promise<void> {
        if (this.connected) {
            logger.warn('Hermes already connected');
            return;
        }

        const ids = assets
            .map(a => PRICE_FEED_IDS[a.toUpperCase()])
            .filter(Boolean);

        if (ids.length === 0) {
            throw new Error(`No price feed IDs found for assets: ${assets.join(', ')}`);
        }

        // Build SSE URL with encoded IDs
        const params = ids.map(id => `ids[]=${encodeURIComponent(id)}`).join('&');
        const url = `${this.baseUrl}?${params}&allow_unordered=true`;

        logger.info({ assets, url: url.substring(0, 100) + '...' }, 'Connecting to Hermes SSE');

        // Dynamically import EventSource for Node.js
        const { EventSource } = await import('eventsource');

        this.eventSource = new EventSource(url);

        this.eventSource.onopen = () => {
            this.connected = true;
            logger.info({ assets }, 'Hermes SSE connected');
            this.emit('connected', { assets });
        };

        this.eventSource.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                this.handleUpdate(data);
            } catch (err: any) {
                logger.error({ err: err?.message, data: event.data }, 'Failed to parse Hermes update');
            }
        };

        this.eventSource.onerror = (err) => {
            logger.error({ err }, 'Hermes SSE error');
            this.connected = false;
            // Do NOT emit('error') — unhandled EventEmitter 'error' events kill the process.
            // scheduleReconnect handles recovery.
            this.scheduleReconnect(assets);
        };
    }

    private handleUpdate(data: any): void {
        if (!data.parsed || !Array.isArray(data.parsed)) return;

        for (const update of data.parsed) {
            const feedId = update.id;
            const asset = this.getAssetFromFeedId(feedId);
            if (!asset) continue;

            const priceData = update.price;
            if (!priceData) continue;

            // Convert from Pyth's integer format to actual price
            // price * 10^expo = actual price
            const rawPrice = BigInt(priceData.price);
            const expo = priceData.expo;
            const price = Number(rawPrice) * Math.pow(10, expo);
            const conf = Number(priceData.conf) * Math.pow(10, expo);
            const timestamp = priceData.publish_time * 1000; // Convert to ms

            this.prices.set(asset, { price, timestamp, conf });
            this.emit('price', { asset, price, conf, timestamp });

            logger.debug({ asset, price, conf }, 'Price update');
        }
    }

    private getAssetFromFeedId(feedId: string): string | null {
        for (const [asset, id] of Object.entries(PRICE_FEED_IDS)) {
            if (id === feedId) return asset;
        }
        return null;
    }

    /**
     * Get the latest cached price for an asset
     */
    getPrice(asset: string): { price: number; timestamp: number; conf: number } | null {
        return this.prices.get(asset.toUpperCase()) || null;
    }

    /**
     * Get all cached prices
     */
    getAllPrices(): Record<string, { price: number; timestamp: number; conf: number }> {
        const result: Record<string, any> = {};
        for (const [asset, data] of this.prices.entries()) {
            result[asset] = data;
        }
        return result;
    }

    disconnect(): void {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }

        if (this.eventSource) {
            this.eventSource.close();
            this.eventSource = null;
        }

        this.connected = false;
        logger.info('Hermes SSE disconnected');
        this.emit('disconnected');
    }

    private scheduleReconnect(assets: string[]): void {
        if (this.reconnectTimer) return;

        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            logger.info('Attempting Hermes reconnect');
            this.connect(assets).catch(err => {
                logger.error({ err }, 'Hermes reconnect failed');
                this.scheduleReconnect(assets);
            });
        }, 5000);
    }
}
