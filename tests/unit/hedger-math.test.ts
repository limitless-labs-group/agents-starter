/**
 * Hedger direction + USDC notional math.
 *
 * Strategy invariants under test:
 *   - net > 0 → too much YES → BUY NO on Poly
 *   - net < 0 → too much NO  → BUY YES on Poly
 *   - notional = |net| × poly_price_of_side_we_buy
 *   - notional < $1.0 → skip (Poly rejects dust)
 *
 * Port of `tests/unit/test_hedger_math.py` from limitless-replicator.
 */

import { describe, expect, it } from 'vitest';
import { decideHedge } from '../../src/strategies/replicator/hedger.js';

describe('decideHedge — direction', () => {
  it('net positive (long YES) → buy NO at 1 - polyBid', () => {
    // net = +10, polyBid = 0.60 → NO price = 0.40, notional = 4.0
    const d = decideHedge({
      netShares: 10,
      hedgeThreshold: 2,
      polyBid: 0.6,
      polyAsk: 0.62,
    });
    expect(d.shouldHedge).toBe(true);
    expect(d.buyYes).toBe(false);
    expect(d.pricePerShare).toBeCloseTo(0.4, 6);
    expect(d.notionalUsdc).toBeCloseTo(4.0, 6);
  });

  it('net negative (long NO) → buy YES at polyAsk', () => {
    // net = -8, polyAsk = 0.62 → YES price = 0.62, notional = 4.96
    const d = decideHedge({
      netShares: -8,
      hedgeThreshold: 2,
      polyBid: 0.6,
      polyAsk: 0.62,
    });
    expect(d.shouldHedge).toBe(true);
    expect(d.buyYes).toBe(true);
    expect(d.pricePerShare).toBeCloseTo(0.62, 6);
    expect(d.notionalUsdc).toBeCloseTo(4.96, 6);
  });
});

describe('decideHedge — gates', () => {
  it('|net| below threshold → skip', () => {
    const d = decideHedge({
      netShares: 1.5,
      hedgeThreshold: 2,
      polyBid: 0.5,
      polyAsk: 0.5,
    });
    expect(d.shouldHedge).toBe(false);
    expect(d.reason).toBe('under threshold');
  });

  it('missing quote (bid|ask null) → skip', () => {
    const d = decideHedge({
      netShares: 10,
      hedgeThreshold: 2,
      polyBid: null,
      polyAsk: 0.62,
    });
    expect(d.shouldHedge).toBe(false);
    expect(d.reason).toBe('no usable price');
  });

  it('notional < $1 → skip (Polymarket rejects dust)', () => {
    // net = 50, polyBid = 0.99 → NO price = 0.01, notional = 0.50 → skip
    const d = decideHedge({
      netShares: 50,
      hedgeThreshold: 2,
      polyBid: 0.99,
      polyAsk: 0.99,
    });
    expect(d.shouldHedge).toBe(false);
    expect(d.reason).toBe('notional too small');
  });

  it('cross-venue offset nets to zero → skip', () => {
    // Long 5 YES on Limitless, long 5 NO on Polymarket → net = 0
    const d = decideHedge({
      netShares: 0,
      hedgeThreshold: 2,
      polyBid: 0.5,
      polyAsk: 0.5,
    });
    expect(d.shouldHedge).toBe(false);
  });

  it('price out of (0, 1) interval → skip', () => {
    const d = decideHedge({
      netShares: 10,
      hedgeThreshold: 2,
      polyBid: 1.0,
      polyAsk: 1.0,
    });
    // polyBid = 1.0 → NO price = 0 (invalid). Skip.
    expect(d.shouldHedge).toBe(false);
    expect(d.reason).toBe('no usable price');
  });
});
