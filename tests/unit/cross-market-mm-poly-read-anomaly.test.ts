/**
 * Position-read anomaly guard — the Jun-25 false -$64 breaker trip.
 *
 * A properly hedged ~flat Spain book read as a $64 loss because poly.getPositions()
 * intermittently returned empty for a pair still holding ~64 YES / ~64 NO, and the
 * hedger collapsed the missing read to {0,0}, dropping its marked value. After 3
 * consecutive phantom-zero ticks the breaker tripped on a loss that never happened.
 *
 * `isSuspiciousPositionZero` is the pure guard; the integration lives in runHedger
 * (it feeds the breaker null on anomaly). Here we test the guard and assert the
 * end-to-end intent against the real RiskMonitor.
 */

import { describe, it, expect } from 'vitest';
import { isSuspiciousPositionZero } from '../../src/strategies/cross-market-mm/hedger.js';
import { RiskMonitor } from '../../src/strategies/cross-market-mm/risk.js';

describe('isSuspiciousPositionZero', () => {
  it('flags a sizable position vanishing to exactly zero (the bug)', () => {
    expect(isSuspiciousPositionZero({ yes: 64.08, no: 0 }, { yes: 0, no: 0 })).toBe(true);
    expect(isSuspiciousPositionZero({ yes: 0, no: 64.07 }, { yes: 0, no: 0 })).toBe(true);
  });

  it('ignores dust vanishing (below the min-shares floor)', () => {
    expect(isSuspiciousPositionZero({ yes: 0.000058, no: 0 }, { yes: 0, no: 0 })).toBe(false);
    expect(isSuspiciousPositionZero({ yes: 2, no: 0 }, { yes: 0, no: 0 })).toBe(false); // < 5
  });

  it('does not flag a stable or recovering read', () => {
    expect(isSuspiciousPositionZero({ yes: 64, no: 64 }, { yes: 64, no: 64 })).toBe(false);
    expect(isSuspiciousPositionZero({ yes: 0, no: 0 }, { yes: 64, no: 0 })).toBe(false); // position appeared
  });

  it('does not flag the first read (no prior)', () => {
    expect(isSuspiciousPositionZero(undefined, { yes: 0, no: 0 })).toBe(false);
    expect(isSuspiciousPositionZero(undefined, { yes: 64, no: 0 })).toBe(false);
  });

  it('respects a custom min-shares threshold', () => {
    expect(isSuspiciousPositionZero({ yes: 3, no: 0 }, { yes: 0, no: 0 }, 2)).toBe(true);
    expect(isSuspiciousPositionZero({ yes: 3, no: 0 }, { yes: 0, no: 0 }, 10)).toBe(false);
  });
});

describe('breaker survives phantom-zero ticks when they are fed as null', () => {
  it('anomaly ticks (null) never advance the breach streak, even at a huge phantom drawdown', () => {
    const risk = new RiskMonitor(5, 3); // $5 kill, 3 consecutive breaches
    risk.update(629.85); // baseline
    // The hedger now feeds anomaly ticks as null instead of the phantom -$64 equity:
    for (let i = 0; i < 5; i++) {
      expect(risk.update(null).tripped).toBe(false);
    }
    // A real recovered tick (still ~flat) confirms we're live and untripped.
    expect(risk.update(629.33).tripped).toBe(false);
  });

  it('sanity: three REAL -$64 ticks would trip (so the guard is what saves us)', () => {
    const risk = new RiskMonitor(5, 3);
    risk.update(629.85);
    risk.update(565.26);
    risk.update(565.26);
    expect(risk.update(565.26).tripped).toBe(true);
  });
});
