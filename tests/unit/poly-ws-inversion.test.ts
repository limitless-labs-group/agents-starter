/**
 * Polymarket WS NO-asset → YES-price inversion.
 *
 * Strategy invariant: everything downstream of the WS listener is
 * YES-frame. A NO-asset update must be inverted:
 *   YES_ask = 1 - NO_bid
 *   YES_bid = 1 - NO_ask
 *
 * If this is wrong, the cross-market-mm quotes on the wrong side of the book.
 */

import { describe, expect, it } from 'vitest';
import { applyBook, applyPriceChange } from '../../src/core/polymarket/ws.js';
import { QuoteFeed } from '../../src/strategies/cross-market-mm/quote-feed.js';

describe('applyBook', () => {
  it('YES asset book passes through unchanged', () => {
    const feed = new QuoteFeed();
    const assetToSlug = new Map([['YES_ID', 'slug-a']]);
    const yesAssets = new Set(['YES_ID']);
    applyBook(
      {
        event_type: 'book',
        asset_id: 'YES_ID',
        bids: [{ price: '0.55', size: '100' }],
        asks: [{ price: '0.57', size: '100' }],
      },
      feed,
      assetToSlug,
      yesAssets,
    );
    const q = feed.getQuote('slug-a')!;
    expect(q.bid).toBeCloseTo(0.55, 9);
    expect(q.ask).toBeCloseTo(0.57, 9);
  });

  it('NO asset book inverts to YES prices', () => {
    const feed = new QuoteFeed();
    const assetToSlug = new Map([['NO_ID', 'slug-a']]);
    const yesAssets = new Set<string>(); // NO_ID not in
    applyBook(
      {
        event_type: 'book',
        asset_id: 'NO_ID',
        bids: [{ price: '0.43', size: '100' }],
        asks: [{ price: '0.45', size: '100' }],
      },
      feed,
      assetToSlug,
      yesAssets,
    );
    const q = feed.getQuote('slug-a')!;
    // YES_ask = 1 - NO_bid = 0.57; YES_bid = 1 - NO_ask = 0.55
    expect(q.ask).toBeCloseTo(0.57, 9);
    expect(q.bid).toBeCloseTo(0.55, 9);
  });

  it('best bid = max price; best ask = min price across levels', () => {
    const feed = new QuoteFeed();
    const assetToSlug = new Map([['YES_ID', 'slug-a']]);
    applyBook(
      {
        event_type: 'book',
        asset_id: 'YES_ID',
        bids: [
          { price: '0.50', size: '100' },
          { price: '0.55', size: '50' }, // best bid
          { price: '0.48', size: '200' },
        ],
        asks: [
          { price: '0.60', size: '100' },
          { price: '0.57', size: '50' }, // best ask
          { price: '0.62', size: '200' },
        ],
      },
      feed,
      assetToSlug,
      new Set(['YES_ID']),
    );
    const q = feed.getQuote('slug-a')!;
    expect(q.bid).toBe(0.55);
    expect(q.ask).toBe(0.57);
  });

  it('unknown asset id is ignored', () => {
    const feed = new QuoteFeed();
    applyBook(
      {
        event_type: 'book',
        asset_id: 'UNKNOWN',
        bids: [{ price: '0.5', size: '1' }],
        asks: [],
      },
      feed,
      new Map([['KNOWN', 'slug-a']]),
      new Set(['KNOWN']),
    );
    expect(feed.getQuote('slug-a')).toBeUndefined();
  });
});

describe('applyPriceChange', () => {
  it('YES asset price_change passes through', () => {
    const feed = new QuoteFeed();
    applyPriceChange(
      {
        event_type: 'price_change',
        asset_id: 'YES_ID',
        price_changes: [{ asset_id: 'YES_ID', best_bid: '0.61', best_ask: '0.63' }],
      },
      feed,
      new Map([['YES_ID', 'slug-b']]),
      new Set(['YES_ID']),
    );
    const q = feed.getQuote('slug-b')!;
    expect(q.bid).toBeCloseTo(0.61, 9);
    expect(q.ask).toBeCloseTo(0.63, 9);
  });

  it('NO asset price_change inverts', () => {
    const feed = new QuoteFeed();
    applyPriceChange(
      {
        event_type: 'price_change',
        asset_id: 'NO_ID',
        price_changes: [{ asset_id: 'NO_ID', best_bid: '0.39', best_ask: '0.41' }],
      },
      feed,
      new Map([['NO_ID', 'slug-b']]),
      new Set<string>(),
    );
    const q = feed.getQuote('slug-b')!;
    expect(q.ask).toBeCloseTo(0.61, 9); // 1 - 0.39
    expect(q.bid).toBeCloseTo(0.59, 9); // 1 - 0.41
  });
});

describe('QuoteFeed', () => {
  it('partial update only mutates provided sides', () => {
    const feed = new QuoteFeed();
    feed.ensureSlug('slug');
    feed.update('slug', 0.5, 0.6);
    expect(feed.getQuote('slug')).toEqual({ bid: 0.5, ask: 0.6 });
    feed.update('slug', 0.55, undefined);
    expect(feed.getQuote('slug')).toEqual({ bid: 0.55, ask: 0.6 });
  });

  it('nextUpdate resolves on next update', async () => {
    const feed = new QuoteFeed();
    feed.ensureSlug('slug');
    const p = feed.nextUpdate('slug');
    feed.update('slug', 0.5, 0.6);
    await expect(p).resolves.toBeUndefined();
  });

  it('nextUpdate is re-awaitable (resolves once per update)', async () => {
    const feed = new QuoteFeed();
    feed.ensureSlug('slug');
    const events: number[] = [];
    let i = 0;
    const consumer = async () => {
      while (i < 3) {
        await feed.nextUpdate('slug');
        events.push(i);
        i++;
      }
    };
    const task = consumer();
    // Three updates → three resolves
    for (let n = 0; n < 3; n++) {
      await new Promise((r) => setTimeout(r, 5));
      feed.update('slug', 0.5 + n * 0.01, 0.6 + n * 0.01);
    }
    await task;
    expect(events).toEqual([0, 1, 2]);
  });
});
