/**
 * Cross-market MM quote math.
 *
 * Strategy invariants under test:
 *   - Fair-value cap: YES BUY <= poly_bid - margin, NO BUY <= (1 - poly_ask) - margin.
 *   - Prices quantized to the whole-cent venue tick, clipped to [TICK, 1 - TICK].
 *   - The Limitless book makes us more competitive UP TO the cap, never above it.
 *   - Book prices normalize from either 0-1 fractions or 0-100 cents.
 */

import { describe, expect, it } from 'vitest';
import {
  TICK,
  bookTop,
  clipPrice,
  computeBuyPrices,
  normPrice,
} from '../../src/strategies/cross-market-mm/index.js';

describe('clipPrice (whole-cent grid)', () => {
  it('clamps to [TICK, 1 - TICK]', () => {
    expect(clipPrice(0.5)).toBe(0.5);
    expect(clipPrice(0)).toBe(TICK);
    expect(clipPrice(-0.5)).toBe(TICK);
    expect(clipPrice(1)).toBe(1 - TICK);
    expect(clipPrice(1.5)).toBe(1 - TICK);
  });

  it('rounds to whole cents (the venue tick)', () => {
    expect(clipPrice(0.12345)).toBeCloseTo(0.12, 2);
    expect(clipPrice(0.627)).toBeCloseTo(0.63, 2);
    expect(clipPrice(0.004)).toBe(TICK); // sub-tick rounds down then clamps up to the floor
  });
});

describe('normPrice', () => {
  it('passes 0-1 fractions through, divides 0-100 cents by 100', () => {
    expect(normPrice(0.63)).toBeCloseTo(0.63, 4);
    expect(normPrice(63)).toBeCloseTo(0.63, 4);
    expect(normPrice(0.5)).toBeCloseTo(0.5, 4);
    expect(normPrice(99)).toBeCloseTo(0.99, 4);
  });
});

describe('bookTop', () => {
  it('returns best (max) bid and best (min) ask, normalized', () => {
    expect(bookTop({ bids: [{ price: '0.60' }, { price: '0.62' }], asks: [{ price: '0.65' }, { price: '0.63' }] }))
      .toEqual({ bid: 0.62, ask: 0.63 });
  });
  it('handles cents-encoded levels', () => {
    expect(bookTop({ bids: [{ price: '60' }, { price: '62' }], asks: [{ price: '65' }] }))
      .toEqual({ bid: 0.62, ask: 0.65 });
  });
  it('nulls on empty or missing book', () => {
    expect(bookTop({ bids: [], asks: [] })).toEqual({ bid: null, ask: null });
    expect(bookTop(null)).toEqual({ bid: null, ask: null });
    expect(bookTop(undefined)).toEqual({ bid: null, ask: null });
  });
});

describe('computeBuyPrices — fair value (no book)', () => {
  it('YES @ poly_bid - margin, NO @ (1 - poly_ask) - margin', () => {
    const { yes, no } = computeBuyPrices(0.6, 0.62, 100); // margin 1 cent
    expect(yes).toBeCloseTo(0.59, 2);
    expect(no).toBeCloseTo(0.37, 2);
  });

  it('zero margin quotes at poly_bid and (1 - poly_ask)', () => {
    const { yes, no } = computeBuyPrices(0.55, 0.57, 0);
    expect(yes).toBeCloseTo(0.55, 2);
    expect(no).toBeCloseTo(0.43, 2);
  });

  it('larger margin pulls both BUY prices down', () => {
    const tight = computeBuyPrices(0.6, 0.62, 100);
    const wide = computeBuyPrices(0.6, 0.62, 500);
    expect(wide.yes).toBeLessThan(tight.yes);
    expect(wide.no).toBeLessThan(tight.no);
  });

  it('clamps to the floor when a side would go negative', () => {
    const { no } = computeBuyPrices(0.5, 0.99, 100); // 1 - 0.99 - 0.01 = 0
    expect(no).toBe(TICK);
  });
});

describe('computeBuyPrices — book-aware competitiveness', () => {
  it('rests one tick below the YES ask when fair value would cross it (the post-only fix)', () => {
    // fairYes would be 0.69 (would cross the 0.65 ask and get rejected post-only);
    // with the book we cap at ask - tick = 0.64.
    const { yes } = computeBuyPrices(0.69, 0.71, 0, { bid: 0.6, ask: 0.65 });
    expect(yes).toBeCloseTo(0.64, 2);
  });

  it('leaves the quote at fair value when fair is already below the book ask', () => {
    // fairYes = 0.59, ask 0.70 → min(0.59, 0.69) = 0.59 (book does not raise us)
    const { yes } = computeBuyPrices(0.6, 0.62, 100, { bid: 0.5, ask: 0.7 });
    expect(yes).toBeCloseTo(0.59, 2);
  });

  it('never quotes above the fair-value cap, even for an adversarial/garbage book', () => {
    const fairYes = 0.6 - 0.01;
    const fairNo = 1 - 0.62 - 0.01;
    const { yes, no } = computeBuyPrices(0.6, 0.62, 100, { bid: 0.99, ask: 0.05 });
    expect(yes).toBeLessThanOrEqual(fairYes + 1e-9);
    expect(no).toBeLessThanOrEqual(fairNo + 1e-9);
  });
});
