/**
 * SDKTradingClient construction + auth resolution + DRY_RUN safety.
 *
 * Doesn't hit the network. Verifies:
 *   - Constructor requires a privateKey.
 *   - Auth resolves HMAC-first (config → env), falls back to legacy apiKey,
 *     and throws when nothing is configured.
 *   - DRY_RUN short-circuits the order paths and never touches the SDK.
 */

import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { SDKTradingClient, resolveAuth } from '../../src/core/limitless/sdk-trading.js';

const TEST_PRIVATE_KEY =
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const HMAC = { tokenId: 'tok-123', secret: 'c2VjcmV0' };

describe('resolveAuth — HMAC-first precedence', () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of ['LMTS_TOKEN_ID', 'LMTS_TOKEN_SECRET', 'LIMITLESS_API_KEY']) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of ['LMTS_TOKEN_ID', 'LMTS_TOKEN_SECRET', 'LIMITLESS_API_KEY']) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('prefers config.hmacCredentials over everything', () => {
    process.env.LMTS_TOKEN_ID = 'env-id';
    process.env.LMTS_TOKEN_SECRET = 'env-secret';
    process.env.LIMITLESS_API_KEY = 'legacy';
    const auth = resolveAuth({ privateKey: TEST_PRIVATE_KEY, hmacCredentials: HMAC });
    expect(auth.hmacCredentials).toEqual(HMAC);
    expect(auth.apiKey).toBeUndefined();
  });

  it('falls to env HMAC over config.apiKey', () => {
    process.env.LMTS_TOKEN_ID = 'env-id';
    process.env.LMTS_TOKEN_SECRET = 'env-secret';
    const auth = resolveAuth({ privateKey: TEST_PRIVATE_KEY, apiKey: 'legacy' });
    expect(auth.hmacCredentials).toEqual({ tokenId: 'env-id', secret: 'env-secret' });
    expect(auth.apiKey).toBeUndefined();
  });

  it('uses config.apiKey when no HMAC anywhere', () => {
    const auth = resolveAuth({ privateKey: TEST_PRIVATE_KEY, apiKey: 'legacy' });
    expect(auth.apiKey).toBe('legacy');
    expect(auth.hmacCredentials).toBeUndefined();
  });

  it('falls to env LIMITLESS_API_KEY last', () => {
    process.env.LIMITLESS_API_KEY = 'env-legacy';
    const auth = resolveAuth({ privateKey: TEST_PRIVATE_KEY });
    expect(auth.apiKey).toBe('env-legacy');
  });

  it('returns empty when nothing configured', () => {
    const auth = resolveAuth({ privateKey: TEST_PRIVATE_KEY });
    expect(auth.hmacCredentials).toBeUndefined();
    expect(auth.apiKey).toBeUndefined();
  });
});

describe('SDKTradingClient', () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of ['DRY_RUN', 'LMTS_TOKEN_ID', 'LMTS_TOKEN_SECRET', 'LIMITLESS_API_KEY']) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of ['DRY_RUN', 'LMTS_TOKEN_ID', 'LMTS_TOKEN_SECRET', 'LIMITLESS_API_KEY']) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('throws if privateKey is missing', () => {
    expect(
      () => new SDKTradingClient({ privateKey: '', hmacCredentials: HMAC }),
    ).toThrow(/privateKey/);
  });

  it('throws if no auth is configured (no hmac, no apiKey, no env)', () => {
    expect(() => new SDKTradingClient({ privateKey: TEST_PRIVATE_KEY })).toThrow(
      /no auth configured/i,
    );
  });

  it('constructs with HMAC credentials', () => {
    const c = new SDKTradingClient({ privateKey: TEST_PRIVATE_KEY, hmacCredentials: HMAC });
    expect(c.getWalletAddress()).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it('constructs with legacy apiKey (fallback path)', () => {
    const c = new SDKTradingClient({ privateKey: TEST_PRIVATE_KEY, apiKey: 'legacy' });
    expect(c.getWalletAddress()).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it('constructs from env HMAC with no explicit auth', () => {
    process.env.LMTS_TOKEN_ID = 'env-id';
    process.env.LMTS_TOKEN_SECRET = 'env-secret';
    const c = new SDKTradingClient({ privateKey: TEST_PRIVATE_KEY });
    expect(c.getWalletAddress()).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it('returns undefined ownerId before any order is placed', () => {
    const c = new SDKTradingClient({ privateKey: TEST_PRIVATE_KEY, hmacCredentials: HMAC });
    expect(c.getOwnerId()).toBeUndefined();
  });

  it('DRY_RUN cancelOrder returns dry-run without network call', async () => {
    process.env.DRY_RUN = 'true';
    const c = new SDKTradingClient({ privateKey: TEST_PRIVATE_KEY, hmacCredentials: HMAC });
    const r = await c.cancelOrder('any-id');
    expect(r.message).toBe('dry-run');
  });

  it('DRY_RUN cancelAll returns dry-run without network call', async () => {
    process.env.DRY_RUN = 'true';
    const c = new SDKTradingClient({ privateKey: TEST_PRIVATE_KEY, hmacCredentials: HMAC });
    const r = await c.cancelAll('any-slug');
    expect(r.message).toBe('dry-run');
  });
});
