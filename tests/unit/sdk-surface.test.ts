/**
 * SDK surface contract — guards the `@limitless-exchange/sdk` API this repo
 * depends on.
 *
 * The repo runs on the official SDK (see `src/core/limitless/sdk-trading.ts`
 * and `derive-token.ts`). When the SDK is bumped (e.g. a Dependabot PR), this
 * test fails fast if any method/symbol the repo calls has been renamed or
 * removed — catching a breaking SDK change at `npm test` / in CI instead of at
 * a live run. It does NOT hit the network: it constructs the clients offline and
 * only asserts that the call surface exists.
 *
 * If this test fails after an SDK bump: the SDK changed its API. Reconcile
 * `sdk-trading.ts` + `derive-token.ts` with the new surface, then update the
 * assertions below to match.
 */
import { describe, it, expect } from 'vitest';
import { Client, HttpClient, type OrderClient } from '@limitless-exchange/sdk';

// Public Anvil test key — offline account derivation only; never funded or used.
const TEST_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';

describe('@limitless-exchange/sdk surface (breaks loudly on SDK API changes)', () => {
  const client = Client.fromHttpClient(new HttpClient({ apiKey: 'surface-test' }));

  it('Client.fromHttpClient + the domain services the repo calls exist', () => {
    expect(typeof Client.fromHttpClient).toBe('function');
    // sdk.markets.getMarket — run.ts resolveLimitlessMarket
    expect(typeof client.markets.getMarket).toBe('function');
    // sdk.portfolio.{getPositions,getCLOBPositions} — hedger.ts + preflight.ts
    expect(typeof client.portfolio.getPositions).toBe('function');
    expect(typeof client.portfolio.getCLOBPositions).toBe('function');
    // sdk.apiTokens.deriveToken — derive-token.ts (headless HMAC derivation)
    expect(typeof client.apiTokens.deriveToken).toBe('function');
    // client.newOrderClient — sdk-trading.ts constructs the order client from a key
    expect(typeof client.newOrderClient).toBe('function');
  });

  it('the OrderClient surface SDKTradingClient uses exists', () => {
    const oc: OrderClient = client.newOrderClient(TEST_KEY);
    expect(typeof oc.createOrder).toBe('function'); // sellShares / quoting / hedging paths
    expect(typeof oc.cancel).toBe('function'); // cancelOrder
    expect(typeof oc.cancelAll).toBe('function'); // cancelAll / cancelAllAndVerify
  });
});
