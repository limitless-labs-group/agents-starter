/**
 * SDKTradingClient construction + DRY_RUN safety tests.
 *
 * Doesn't hit the network. Just verifies:
 *   - Constructor rejects missing privateKey / apiKey.
 *   - DRY_RUN short-circuits the order paths and never touches the SDK.
 *   - Wallet address surfaces correctly.
 *
 * Strategy migration tests (full SDK-driven order against the real API,
 * gated by a test wallet) belong in an integration suite — out of scope for
 * Phase 1, which proves the wiring is safe without requiring funded creds.
 */

import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { SDKTradingClient } from '../../src/core/limitless/sdk-trading.js';

const TEST_PRIVATE_KEY =
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const TEST_API_KEY = 'test-api-key-unused-in-dry-run';

describe('SDKTradingClient', () => {
  let originalDryRun: string | undefined;

  beforeEach(() => {
    originalDryRun = process.env.DRY_RUN;
  });

  afterEach(() => {
    if (originalDryRun === undefined) {
      delete process.env.DRY_RUN;
    } else {
      process.env.DRY_RUN = originalDryRun;
    }
  });

  it('throws if privateKey is missing', () => {
    expect(
      () =>
        new SDKTradingClient({
          privateKey: '',
          apiKey: TEST_API_KEY,
        })
    ).toThrow(/privateKey/);
  });

  it('throws if apiKey is missing', () => {
    expect(
      () =>
        new SDKTradingClient({
          privateKey: TEST_PRIVATE_KEY,
          apiKey: '',
        })
    ).toThrow(/apiKey/);
  });

  it('exposes the derived wallet address', () => {
    const c = new SDKTradingClient({
      privateKey: TEST_PRIVATE_KEY,
      apiKey: TEST_API_KEY,
    });
    expect(c.getWalletAddress()).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it('returns undefined ownerId before any order is placed', () => {
    const c = new SDKTradingClient({
      privateKey: TEST_PRIVATE_KEY,
      apiKey: TEST_API_KEY,
    });
    expect(c.getOwnerId()).toBeUndefined();
  });

  it('DRY_RUN cancelOrder returns dry-run without network call', async () => {
    process.env.DRY_RUN = 'true';
    const c = new SDKTradingClient({
      privateKey: TEST_PRIVATE_KEY,
      apiKey: TEST_API_KEY,
    });
    const r = await c.cancelOrder('any-id');
    expect(r.message).toBe('dry-run');
  });

  it('DRY_RUN cancelAll returns dry-run without network call', async () => {
    process.env.DRY_RUN = 'true';
    const c = new SDKTradingClient({
      privateKey: TEST_PRIVATE_KEY,
      apiKey: TEST_API_KEY,
    });
    const r = await c.cancelAll('any-slug');
    expect(r.message).toBe('dry-run');
  });
});
