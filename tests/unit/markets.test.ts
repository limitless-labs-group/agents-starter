/**
 * LimitlessClient over a fake SDK: request shapes for the raw list/search
 * endpoints, response tolerance, and token-id normalization.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Client } from '@limitless-exchange/sdk';
import { LimitlessClient, normalizeMarket } from '../../src/core/limitless/markets.js';
import { marketTokenIds, toFraction, takerDelayMs } from '../../src/core/limitless/types.js';

function fakeSdk(overrides: Partial<{ get: ReturnType<typeof vi.fn>; getMarket: ReturnType<typeof vi.fn>; getOrderBook: ReturnType<typeof vi.fn> }> = {}) {
  const get = overrides.get ?? vi.fn();
  const getMarket = overrides.getMarket ?? vi.fn();
  const getOrderBook = overrides.getOrderBook ?? vi.fn();
  const sdk = { http: { get }, markets: { getMarket, getOrderBook } } as unknown as Client;
  return { sdk, get, getMarket, getOrderBook };
}

describe('LimitlessClient.getActiveMarkets', () => {
  it('passes tradeType/limit/page/sortBy as query params and unwraps { data }', async () => {
    const { sdk, get } = fakeSdk({
      get: vi.fn().mockResolvedValue({ data: [{ slug: 'a', tokens: { yes: '1', no: '2' } }], totalMarketsCount: 1 }),
    });
    const markets = await new LimitlessClient(sdk).getActiveMarkets({ tradeType: 'clob', limit: 25, page: 2, sortBy: 'ending_soon' });
    expect(get).toHaveBeenCalledWith('/markets/active', {
      params: { tradeType: 'clob', limit: 25, page: 2, sortBy: 'ending_soon' },
    });
    expect(markets[0].positionIds).toEqual(['1', '2']);
  });

  it('routes a category filter to /markets/active/:categoryId', async () => {
    const { sdk, get } = fakeSdk({ get: vi.fn().mockResolvedValue({ data: [] }) });
    await new LimitlessClient(sdk).getActiveMarkets({ category: 7, limit: 5 });
    expect(get.mock.calls[0][0]).toBe('/markets/active/7');
  });
});

describe('LimitlessClient.searchMarkets', () => {
  it('sends the query and tolerates array / {markets} / {data} bodies', async () => {
    const shapes = [[{ slug: 'x' }], { markets: [{ slug: 'x' }] }, { data: [{ slug: 'x' }] }];
    for (const body of shapes) {
      const { sdk, get } = fakeSdk({ get: vi.fn().mockResolvedValue(body) });
      const res = await new LimitlessClient(sdk).searchMarkets('btc', { limit: 3 });
      expect(get).toHaveBeenCalledWith('/markets/search', { params: { query: 'btc', limit: 3 } });
      expect(res.map((m) => m.slug)).toEqual(['x']);
    }
  });
});

describe('LimitlessClient.getMarket / getVenue', () => {
  it('uses the typed fetcher, normalizes ids, and caches the venue', async () => {
    const getMarket = vi.fn().mockResolvedValue({
      slug: 'm',
      positionIds: ['11', '22'],
      venue: { exchange: '0xE', adapter: null },
    });
    const { sdk } = fakeSdk({ getMarket });
    const client = new LimitlessClient(sdk);
    const market = await client.getMarket('m');
    expect(market.tokens).toEqual({ yes: '11', no: '22' });
    expect(await client.getVenue('m')).toEqual({ exchange: '0xE', adapter: null });
    expect(getMarket).toHaveBeenCalledTimes(1); // venue served from cache
  });
});

describe('helpers', () => {
  it('normalizeMarket mirrors tokens <-> positionIds', () => {
    expect(normalizeMarket({ tokens: { yes: 'y', no: 'n' } } as never).positionIds).toEqual(['y', 'n']);
    expect(normalizeMarket({ positionIds: ['y', 'n'] } as never).tokens).toEqual({ yes: 'y', no: 'n' });
  });

  it('marketTokenIds throws on a market with no ids', () => {
    expect(() => marketTokenIds({ slug: 'bad' })).toThrow(/no YES\/NO token ids/);
    expect(marketTokenIds({ slug: 'ok', positionIds: ['1', '2'] })).toEqual({ yes: '1', no: '2' });
  });

  it('toFraction accepts cents or fractions', () => {
    expect(toFraction(42.8)).toBeCloseTo(0.428);
    expect(toFraction(0.428)).toBeCloseTo(0.428);
    expect(toFraction('55')).toBeCloseTo(0.55);
    expect(toFraction(undefined)).toBe(0);
  });

  it('takerDelayMs reads the untyped settings field, defaulting to 0', () => {
    expect(takerDelayMs({ settings: { takerDelayMs: 1250 } as never })).toBe(1250);
    expect(takerDelayMs({ settings: undefined })).toBe(0);
  });
});
