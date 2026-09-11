/**
 * Auth resolution for the shared SDK client factory: HMAC first, legacy last,
 * and public reads never need credentials.
 */
import { describe, it, expect } from 'vitest';
import {
  createSdkClient,
  createWebSocketClient,
  getApiBaseUrl,
  hasAuth,
  isLegacyAuth,
  resolveAuth,
} from '../../src/core/limitless/client.js';

const HMAC = { tokenId: 'tok', secret: 'c2VjcmV0' };

describe('resolveAuth (env injected, no process.env mutation)', () => {
  it('prefers explicit HMAC over everything', () => {
    const auth = resolveAuth({ hmacCredentials: HMAC, apiKey: 'legacy' }, { LMTS_TOKEN_ID: 'e', LMTS_TOKEN_SECRET: 's', LIMITLESS_API_KEY: 'k' });
    expect(auth).toEqual({ hmacCredentials: HMAC });
  });

  it('then env HMAC over explicit apiKey', () => {
    const auth = resolveAuth({ apiKey: 'legacy' }, { LMTS_TOKEN_ID: 'e', LMTS_TOKEN_SECRET: 's' });
    expect(auth).toEqual({ hmacCredentials: { tokenId: 'e', secret: 's' } });
  });

  it('then explicit apiKey, then env LIMITLESS_API_KEY', () => {
    expect(resolveAuth({ apiKey: 'legacy' }, {})).toEqual({ apiKey: 'legacy' });
    expect(resolveAuth({}, { LIMITLESS_API_KEY: 'k' })).toEqual({ apiKey: 'k' });
  });

  it('half an HMAC pair does not count', () => {
    expect(resolveAuth({}, { LMTS_TOKEN_ID: 'only-id' })).toEqual({});
  });

  it('hasAuth / isLegacyAuth classify correctly', () => {
    expect(hasAuth({})).toBe(false);
    expect(hasAuth({ apiKey: 'k' })).toBe(true);
    expect(isLegacyAuth({ apiKey: 'k' })).toBe(true);
    expect(isLegacyAuth({ hmacCredentials: HMAC })).toBe(false);
  });
});

describe('client factories', () => {
  it('build an SDK client with no auth (public reads) and with HMAC', () => {
    const anon = createSdkClient({ baseURL: 'https://example.test' });
    expect(typeof anon.markets.getMarket).toBe('function');
    expect(anon.http.getHMACCredentials()).toBeUndefined();

    const authed = createSdkClient({ hmacCredentials: HMAC });
    expect(authed.http.getHMACCredentials()).toEqual(HMAC);
  });

  it('build a websocket client that is not connected until asked', () => {
    const ws = createWebSocketClient({ hmacCredentials: HMAC, wsUrl: 'wss://example.test' });
    expect(ws.isConnected()).toBe(false);
  });

  it('base URL override wins over the default', () => {
    expect(getApiBaseUrl('https://x.test')).toBe('https://x.test');
    expect(getApiBaseUrl()).toMatch(/^https:\/\//);
  });
});
