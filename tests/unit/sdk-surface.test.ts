/**
 * SDK surface contract — guards the `@limitless-exchange/sdk` API this repo
 * depends on.
 *
 * Every module in `src/core/limitless/` builds on the SDK. When the SDK is
 * bumped (e.g. a Dependabot PR), this test fails fast if any method the repo
 * calls has been renamed or removed, catching a breaking change at
 * `npm test` / in CI instead of at a live run. It never hits the network: it
 * constructs the clients offline and asserts the call surface exists.
 *
 * If this fails after an SDK bump: reconcile `src/core/limitless/*` with the
 * new surface, then update the assertions below.
 */
import { describe, it, expect } from 'vitest';
import {
  APIError,
  CancelReplaceMode,
  Client,
  HttpClient,
  OrderType,
  Side,
  WebSocketClient,
  type OrderClient,
} from '@limitless-exchange/sdk';

// Public Anvil test key — offline account derivation only; never funded or used.
const TEST_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';

describe('@limitless-exchange/sdk surface (breaks loudly on SDK API changes)', () => {
  const client = Client.fromHttpClient(new HttpClient({ hmacCredentials: { tokenId: 't', secret: 'c2VjcmV0' } }));

  it('Client.fromHttpClient + the domain services the repo calls exist', () => {
    expect(typeof Client.fromHttpClient).toBe('function');
    // markets.ts / sdk-trading.ts / redeem.ts / doctor.ts
    expect(typeof client.markets.getMarket).toBe('function');
    expect(typeof client.markets.getOrderBook).toBe('function');
    // portfolio.ts / sdk-trading.ts / redeem.ts / doctor.ts
    expect(typeof client.portfolio.getProfile).toBe('function');
    expect(typeof client.portfolio.getPositions).toBe('function');
    expect(typeof client.portfolio.getCLOBPositions).toBe('function');
    expect(typeof client.portfolio.getUserHistory).toBe('function');
    // derive-token.ts
    expect(typeof client.apiTokens.deriveToken).toBe('function');
    // markets.ts (raw list/search endpoints) + sdk-trading.ts (status/batch)
    expect(typeof client.http.get).toBe('function');
    expect(typeof client.http.post).toBe('function');
    // sdk-trading.ts / client.ts
    expect(typeof client.newOrderClient).toBe('function');
    expect(typeof client.newWebSocketClient).toBe('function');
  });

  it('the OrderClient surface SDKTradingClient uses exists', () => {
    const oc: OrderClient = client.newOrderClient(TEST_KEY);
    expect(typeof oc.createOrder).toBe('function');
    expect(typeof oc.cancel).toBe('function');
    expect(typeof oc.cancelAll).toBe('function');
    expect(typeof oc.cancelReplace).toBe('function');
    expect(oc.ownerId).toBeUndefined();
  });

  it('enums the repo maps onto still carry the expected members', () => {
    expect(Side.BUY).toBe(0);
    expect(Side.SELL).toBe(1);
    expect(OrderType.GTC).toBe('GTC');
    expect(OrderType.FOK).toBe('FOK');
    expect(OrderType.FAK).toBe('FAK');
    expect(CancelReplaceMode.STOP_ON_FAILURE).toBe('STOP_ON_FAILURE');
    expect(CancelReplaceMode.ALLOW_FAILURE).toBe('ALLOW_FAILURE');
  });

  it('the WebSocketClient surface LimitlessStream uses exists', () => {
    const ws = new WebSocketClient({ url: 'wss://ws.limitless.exchange' });
    expect(typeof ws.connect).toBe('function');
    expect(typeof ws.disconnect).toBe('function');
    expect(typeof ws.subscribe).toBe('function');
    expect(typeof ws.on).toBe('function');
    expect(typeof ws.off).toBe('function');
    expect(typeof ws.isConnected).toBe('function');
    expect(ws.isConnected()).toBe(false);
  });

  it('typed API errors carry a status (doctor branches on 401)', () => {
    const err = new APIError('nope', 401);
    expect(err).toBeInstanceOf(Error);
    expect(err.status).toBe(401);
  });
});
