/**
 * Replicator quote math.
 *
 * Strategy invariants under test:
 *   - YES BUY @ poly_bid - margin
 *   - NO  BUY @ (1 - poly_ask) - margin
 *   - Prices clipped to (0.001, 0.999), rounded to 0.001 tick.
 *
 * Port of `tests/unit/test_replicator_math.py` from limitless-replicator.
 */

import { describe, expect, it } from 'vitest';
import { clipPrice, computeBuyPrices } from '../../src/strategies/cross-market-mm/index.js';

describe('clipPrice', () => {
  it('keeps prices in the open interval (0, 1)', () => {
    expect(clipPrice(0.5)).toBe(0.5);
    expect(clipPrice(0)).toBe(0.001);
    expect(clipPrice(-0.5)).toBe(0.001);
    expect(clipPrice(1)).toBe(0.999);
    expect(clipPrice(1.5)).toBe(0.999);
  });

  it('rounds to three decimals', () => {
    expect(clipPrice(0.12345)).toBe(0.123);
    expect(clipPrice(0.99949)).toBeCloseTo(0.999, 3);
    expect(clipPrice(0.0009)).toBe(0.001);
  });
});

describe('computeBuyPrices — strategy invariants', () => {
  it('YES @ poly_bid - margin, NO @ (1 - poly_ask) - margin', () => {
    // poly_bid 0.60, poly_ask 0.62, margin 100 bps = 0.01
    // YES = 0.60 - 0.01 = 0.59
    // NO  = (1 - 0.62) - 0.01 = 0.37
    const { yes, no } = computeBuyPrices(0.6, 0.62, 100);
    expect(yes).toBeCloseTo(0.59, 3);
    expect(no).toBeCloseTo(0.37, 3);
  });

  it('zero margin → quotes at poly_bid and (1 - poly_ask)', () => {
    const { yes, no } = computeBuyPrices(0.55, 0.57, 0);
    expect(yes).toBeCloseTo(0.55, 3);
    expect(no).toBeCloseTo(0.43, 3);
  });

  it('larger margin pulls both BUY prices DOWN (further inside the book)', () => {
    const tight = computeBuyPrices(0.6, 0.62, 100); // 1% margin
    const wide = computeBuyPrices(0.6, 0.62, 500); // 5% margin
    expect(wide.yes).toBeLessThan(tight.yes);
    expect(wide.no).toBeLessThan(tight.no);
  });

  it('clips to 0.001 floor when (1 - poly_ask) - margin would go negative', () => {
    // poly_ask = 0.999, margin 100 bps = 0.01
    // NO_raw = 1 - 0.999 - 0.01 = -0.009 → clipped to 0.001
    const { no } = computeBuyPrices(0.5, 0.999, 100);
    expect(no).toBe(0.001);
  });

  it('clips to 0.999 ceiling when poly_bid - margin would overshoot', () => {
    // poly_bid = 0.999, negative margin (test only) would push above 0.999
    // Using the real BUY model: poly_bid 0.9991, margin 0 → 0.9991 → clipped to 0.999
    const { yes } = computeBuyPrices(0.9991, 0.9999, 0);
    expect(yes).toBe(0.999);
  });
});
