import { io, Socket } from 'socket.io-client';
import { pino } from 'pino';

// Event types
export type PriceUpdate = {
    marketAddress: string;
    prices: number[]; // [YES, NO]
    timestamp: number;
};

export type OrderbookUpdate = {
    marketSlug: string;
    bids: any[];
    asks: any[];
    timestamp: number;
};

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

export class LimitlessWebSocket {
    private socket: Socket | null = null;
    private subscribedSlugs: Set<string> = new Set();
    private subscribedAddresses: Set<string> = new Set();

    constructor(
        private url: string = process.env.LIMITLESS_WS_URL || 'wss://ws.limitless.exchange',
        private apiKey?: string
    ) {
        this.apiKey = this.apiKey || process.env.LIMITLESS_API_KEY;
    }

    connect(): void {
        if (this.socket?.connected) return;

        logger.info({ url: this.url }, 'Connecting to Limitless WebSocket');

        this.socket = io(this.url, {
            path: '/socket.io',
            transports: ['websocket'],
            extraHeaders: this.apiKey ? { 'X-API-Key': this.apiKey } : {},
            reconnection: true,
            reconnectionDelay: 1000,
            reconnectionDelayMax: 5000,
        });

        this.socket.on('connect', () => {
            logger.info('WebSocket connected');
            this.resubscribe(); // Re-send subscriptions on reconnect
        });

        this.socket.on('disconnect', (reason) => {
            logger.warn({ reason }, 'WebSocket disconnected');
        });

        this.socket.on('error', (err) => {
            logger.error({ err }, 'WebSocket error');
        });

        // Listeners for data
        this.socket.on('newPriceData', (data: any) => {
            // data: { marketAddress, updatedPrices, ... }
            logger.trace({ data }, 'Price update received');
            // Emit to internal listeners if needed, or strategies can attach directly to this.socket
        });

        this.socket.on('orderbookUpdate', (data: any) => {
            logger.trace({ slug: data.marketSlug }, 'Orderbook update received');
        });
    }

    // Specific method for AMM prices (uses addresses)
    subscribeAmmPrices(addresses: string[]): void {
        this.subscribe([], addresses);
    }

    // Specific method for CLOB orderbooks (uses slugs)
    subscribeClobOrderbook(slugs: string[]): void {
        this.subscribe(slugs, []);
    }

    // General subscription method
    subscribe(slugs: string[] = [], addresses: string[] = []): void {
        let changed = false;

        slugs.forEach(s => {
            if (!this.subscribedSlugs.has(s)) {
                this.subscribedSlugs.add(s);
                changed = true;
            }
        });

        addresses.forEach(a => {
            if (!this.subscribedAddresses.has(a)) {
                this.subscribedAddresses.add(a);
                changed = true;
            }
        });

        if (changed) {
            this.emitSubscriptions();
        }
    }

    unsubscribe(slugs: string[] = [], addresses: string[] = []): void {
        let changed = false;

        slugs.forEach(s => {
            if (this.subscribedSlugs.delete(s)) {
                changed = true;
            }
        });

        addresses.forEach(a => {
            if (this.subscribedAddresses.delete(a)) {
                changed = true;
            }
        });

        if (changed) {
            this.emitSubscriptions();
        }
    }

    private emitSubscriptions(): void {
        if (!this.socket?.connected) return;

        const payload = {
            marketAddresses: Array.from(this.subscribedAddresses),
            marketSlugs: Array.from(this.subscribedSlugs),
        };

        logger.debug({
            slugsValues: payload.marketSlugs.length,
            addressesCount: payload.marketAddresses.length
        }, 'Updating subscriptions');

        this.socket.emit('subscribe_market_prices', payload);
    }

    private resubscribe(): void {
        if (this.subscribedSlugs.size > 0 || this.subscribedAddresses.size > 0) {
            this.emitSubscriptions();
        }
    }

    disconnect(): void {
        if (this.socket) {
            this.socket.disconnect();
            this.socket = null;
        }
    }

    // Expose socket for attaching listeners
    get underlyingSocket(): Socket | null {
        return this.socket;
    }
}
