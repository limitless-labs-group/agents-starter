/**
 * LimitlessStream over a fake SDK WebSocketClient: replace semantics on
 * market subscriptions, auth-gated channels, and the orderEvent discriminators.
 */
import { describe, it, expect, vi } from 'vitest';
import type { OrderEvent, WebSocketClient } from '@limitless-exchange/sdk';
import { LimitlessStream, isOmeEvent, isSettlementEvent, isTerminalOrderEvent } from '../../src/core/limitless/websocket.js';

function fakeWs() {
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  const ws = {
    connected: false,
    subscribe: vi.fn().mockResolvedValue(undefined),
    connect: vi.fn(async function (this: { connected: boolean }) {
      this.connected = true;
    }),
    disconnect: vi.fn(async function (this: { connected: boolean }) {
      this.connected = false;
    }),
    isConnected() {
      return this.connected;
    },
    on(event: string, handler: (...args: unknown[]) => void) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      return this;
    },
    off: vi.fn(),
    emit(event: string, payload: unknown) {
      for (const h of handlers.get(event) ?? []) h(payload);
    },
  };
  return ws as unknown as WebSocketClient & { emit: (e: string, p: unknown) => void };
}

describe('LimitlessStream market subscriptions (replace semantics)', () => {
  it('subscribeMarkets sends the full set as marketSlugs', async () => {
    const ws = fakeWs();
    const stream = new LimitlessStream(ws);
    await stream.connect();
    await stream.subscribeMarkets(['a', 'b']);
    expect(ws.subscribe).toHaveBeenLastCalledWith('subscribe_market_prices', { marketSlugs: ['a', 'b'] });
  });

  it('addMarkets / removeMarkets re-emit the whole remaining set', async () => {
    const ws = fakeWs();
    const stream = new LimitlessStream(ws);
    await stream.subscribeMarkets(['a']);
    await stream.addMarkets(['b'], ['0xAMM']);
    expect(ws.subscribe).toHaveBeenLastCalledWith('subscribe_market_prices', { marketSlugs: ['a', 'b'], marketAddresses: ['0xAMM'] });
    await stream.removeMarkets(['a']);
    expect(ws.subscribe).toHaveBeenLastCalledWith('subscribe_market_prices', { marketSlugs: ['b'], marketAddresses: ['0xAMM'] });
    expect(stream.subscriptions.marketSlugs).toEqual(['b']);
  });

  it('never sends an empty payload (the gateway rejects it)', async () => {
    const ws = fakeWs();
    const stream = new LimitlessStream(ws);
    await stream.subscribeMarkets(['a']);
    const calls = (ws.subscribe as ReturnType<typeof vi.fn>).mock.calls.length;
    await stream.removeMarkets(['a']);
    expect((ws.subscribe as ReturnType<typeof vi.fn>).mock.calls.length).toBe(calls);
  });

  it('order events and positions use their dedicated channels with no payload', async () => {
    const ws = fakeWs();
    const stream = new LimitlessStream(ws);
    await stream.subscribeOrderEvents();
    await stream.subscribePositions();
    expect(ws.subscribe).toHaveBeenCalledWith('subscribe_order_events');
    expect(ws.subscribe).toHaveBeenCalledWith('subscribe_positions');
    expect(stream.subscriptions.orderEvents).toBe(true);
  });

  it('routes orderbookUpdate and orderEvent frames to typed handlers', () => {
    const ws = fakeWs();
    const stream = new LimitlessStream(ws);
    const books: string[] = [];
    const events: string[] = [];
    stream.onOrderbook((u) => books.push(u.marketSlug));
    stream.onOrderEvent((e) => events.push(e.type));
    ws.emit('orderbookUpdate', { marketSlug: 'm', orderbook: { bids: [], asks: [] } });
    ws.emit('orderEvent', { source: 'OME', type: 'PLACEMENT' });
    expect(books).toEqual(['m']);
    expect(events).toEqual(['PLACEMENT']);
  });
});

describe('orderEvent discriminators', () => {
  const ome = { source: 'OME', type: 'PLACEMENT' } as OrderEvent;
  const execution = { source: 'OME', type: 'EXECUTION', status: 'FILLED' } as OrderEvent;
  const matched = { source: 'SETTLEMENT', type: 'MATCHED' } as OrderEvent;
  const mined = { source: 'SETTLEMENT', type: 'MINED' } as OrderEvent;

  it('splits on source', () => {
    expect(isOmeEvent(ome)).toBe(true);
    expect(isSettlementEvent(ome)).toBe(false);
    expect(isSettlementEvent(matched)).toBe(true);
  });

  it('terminal = OME EXECUTION or settlement MINED/FAILED', () => {
    expect(isTerminalOrderEvent(ome)).toBe(false);
    expect(isTerminalOrderEvent(execution)).toBe(true);
    expect(isTerminalOrderEvent(matched)).toBe(false);
    expect(isTerminalOrderEvent(mined)).toBe(true);
  });
});
