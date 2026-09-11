/**
 * LimitlessStream — real-time market data and order events over the SDK's
 * `WebSocketClient` (Socket.IO, `wss://ws.limitless.exchange`).
 *
 * What the gateway actually does, so the helpers here match it:
 *
 *   - `subscribe_market_prices` has REPLACE semantics. Every call drops the
 *     previous market set on that connection and joins the new one, then the
 *     server pushes one `orderbookUpdate` snapshot per CLOB slug (empty books
 *     included), so no REST call is needed to seed local state. To "unsubscribe"
 *     from one market, re-subscribe with the smaller set.
 *   - `subscribe_order_events` needs an HMAC-signed handshake (the SDK signs it
 *     from `hmacCredentials`). It is per-account: every order you are party to,
 *     across all markets. Frames arrive on `orderEvent`; discriminate on
 *     `source` (`OME` vs `SETTLEMENT`) then `type`.
 *   - There is no generic `unsubscribe`; only market lifecycle has one. The SDK
 *     re-emits subscriptions after a reconnect.
 *
 * @see https://docs.limitless.exchange/developers/websocket/overview
 * @see https://docs.limitless.exchange/developers/websocket/market-data#initial-snapshot
 * @see https://docs.limitless.exchange/developers/websocket/order-events
 */

import type {
  OmeOrderEvent,
  OrderEvent,
  OrderbookUpdate,
  SettlementOrderEvent,
  WebSocketClient,
  WebSocketEvents,
} from '@limitless-exchange/sdk';
import { pino } from 'pino';
import { createWebSocketClient, type LimitlessClientOptions } from './client.js';

const logger = pino({ level: process.env.LOG_LEVEL || 'info', name: 'limitless-stream' });

export type { OmeOrderEvent, OrderEvent, OrderbookUpdate, SettlementOrderEvent };

/** Off-chain matching-engine frame: PLACEMENT / UPDATE / CANCELLATION / EXECUTION. */
export function isOmeEvent(event: OrderEvent): event is OmeOrderEvent {
  return event.source === 'OME';
}

/** Settlement frame: provisional MATCHED, then terminal MINED / FAILED. */
export function isSettlementEvent(event: OrderEvent): event is SettlementOrderEvent {
  return event.source === 'SETTLEMENT';
}

/** True once an order can no longer change: FAK/FOK EXECUTION, or settlement MINED/FAILED. */
export function isTerminalOrderEvent(event: OrderEvent): boolean {
  if (isOmeEvent(event)) return event.type === 'EXECUTION';
  return event.type === 'MINED' || event.type === 'FAILED';
}

export class LimitlessStream {
  readonly ws: WebSocketClient;
  private marketSlugs = new Set<string>();
  private marketAddresses = new Set<string>();
  private wantOrderEvents = false;
  private wantPositions = false;

  constructor(wsOrOptions: WebSocketClient | LimitlessClientOptions = {}) {
    this.ws = isWsClient(wsOrOptions) ? wsOrOptions : createWebSocketClient(wsOrOptions);
    this.ws.on('connect', () => logger.info('websocket connected'));
    this.ws.on('disconnect', (reason) => logger.warn({ reason }, 'websocket disconnected'));
    this.ws.on('reconnecting', (attempt) => logger.info({ attempt }, 'websocket reconnecting'));
    this.ws.on('error', (err) => logger.error({ err: err?.message }, 'websocket error'));
    this.ws.on('system', (msg) => logger.debug({ msg }, 'system message'));
  }

  async connect(): Promise<void> {
    if (this.ws.isConnected()) return;
    await this.ws.connect();
  }

  async disconnect(): Promise<void> {
    await this.ws.disconnect();
  }

  /**
   * Subscribe to orderbooks (by slug) and AMM prices (by address). Replaces
   * the connection's whole market set. Expect one `orderbookUpdate` snapshot
   * per CLOB slug right after the ack.
   */
  async subscribeMarkets(slugs: string[], addresses: string[] = []): Promise<void> {
    this.marketSlugs = new Set(slugs);
    this.marketAddresses = new Set(addresses);
    await this.emitMarketSubscription();
  }

  /** Add markets to the current set (re-emits the full set; replace semantics). */
  async addMarkets(slugs: string[], addresses: string[] = []): Promise<void> {
    slugs.forEach((s) => this.marketSlugs.add(s));
    addresses.forEach((a) => this.marketAddresses.add(a));
    await this.emitMarketSubscription();
  }

  /** Drop markets from the current set (re-emits the remaining set). */
  async removeMarkets(slugs: string[], addresses: string[] = []): Promise<void> {
    slugs.forEach((s) => this.marketSlugs.delete(s));
    addresses.forEach((a) => this.marketAddresses.delete(a));
    if (this.marketSlugs.size === 0 && this.marketAddresses.size === 0) {
      logger.warn('no markets left to subscribe; the gateway rejects an empty payload, keeping last set');
      return;
    }
    await this.emitMarketSubscription();
  }

  /** Your own order lifecycle + settlement events. Requires HMAC credentials. */
  async subscribeOrderEvents(): Promise<void> {
    this.wantOrderEvents = true;
    await this.ws.subscribe('subscribe_order_events');
  }

  /** Your position balance updates. Requires HMAC credentials. */
  async subscribePositions(): Promise<void> {
    this.wantPositions = true;
    await this.ws.subscribe('subscribe_positions');
  }

  /** Typed listener passthrough (`orderbookUpdate`, `orderEvent`, `positions`, ...). */
  on<K extends keyof WebSocketEvents>(event: K, handler: WebSocketEvents[K]): this {
    this.ws.on(event, handler);
    return this;
  }

  off<K extends keyof WebSocketEvents>(event: K, handler?: WebSocketEvents[K]): this {
    this.ws.off(event, handler);
    return this;
  }

  onOrderbook(handler: (update: OrderbookUpdate) => void): this {
    return this.on('orderbookUpdate', handler);
  }

  onOrderEvent(handler: (event: OrderEvent) => void): this {
    return this.on('orderEvent', handler);
  }

  /** Snapshot of what this stream is subscribed to (for diagnostics/tests). */
  get subscriptions() {
    return {
      marketSlugs: [...this.marketSlugs],
      marketAddresses: [...this.marketAddresses],
      orderEvents: this.wantOrderEvents,
      positions: this.wantPositions,
    };
  }

  private async emitMarketSubscription(): Promise<void> {
    const marketSlugs = [...this.marketSlugs];
    const marketAddresses = [...this.marketAddresses];
    if (marketSlugs.length === 0 && marketAddresses.length === 0) return;
    await this.ws.subscribe('subscribe_market_prices', {
      ...(marketSlugs.length ? { marketSlugs } : {}),
      ...(marketAddresses.length ? { marketAddresses } : {}),
    });
    logger.debug({ slugs: marketSlugs.length, addresses: marketAddresses.length }, 'market subscription sent');
  }
}

function isWsClient(value: WebSocketClient | LimitlessClientOptions): value is WebSocketClient {
  return typeof (value as WebSocketClient).subscribe === 'function';
}
