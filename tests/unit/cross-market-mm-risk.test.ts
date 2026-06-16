/**
 * RiskMonitor circuit-breaker logic + equity helpers.
 * Pure (no network) — readBaseUsdc is not exercised here.
 */

import { describe, it, expect } from 'vitest';
import { RiskMonitor, totalEquity, markPairValue } from '../../src/strategies/cross-market-mm/risk.js';

describe('totalEquity', () => {
  it('sums pUSD + Base USDC + position value (locked is already in USDC)', () => {
    expect(totalEquity({ pUSD: 20, lmtsFreeUsd: 30, posValue: 2 })).toBe(52);
  });
});

describe('markPairValue', () => {
  it('marks YES at mid and NO at 1-mid', () => {
    // 5 YES @ 0.6 + 3 NO @ 0.4 = 3.0 + 1.2 = 4.2
    expect(markPairValue({ yes: 5, no: 0 }, { yes: 0, no: 3 }, 0.6)).toBeCloseTo(3.0 + 1.2, 6);
  });
  it('falls back to 0.5 when mid is unusable', () => {
    // 4 total YES @ 0.5 + 4 total NO @ 0.5 = 4
    expect(markPairValue({ yes: 2, no: 2 }, { yes: 2, no: 2 }, null)).toBeCloseTo(4, 6);
  });
});

describe('RiskMonitor', () => {
  it('sets baseline on first valid update, no trip', () => {
    const r = new RiskMonitor(10);
    const res = r.update(50);
    expect(res.pnl).toBe(0);
    expect(res.tripped).toBe(false);
    expect(r.baseline()).toBe(50);
  });

  it('does not trip above the kill threshold', () => {
    const r = new RiskMonitor(10);
    r.update(50);
    const res = r.update(42); // -8 drawdown, kill is -10
    expect(res.pnl).toBe(-8);
    expect(res.tripped).toBe(false);
  });

  it('trips immediately when requiredBreaches = 1', () => {
    const r = new RiskMonitor(10, 1);
    r.update(50);
    const res = r.update(40); // -10, one breach is enough
    expect(res.tripped).toBe(true);
    expect(r.isTripped()).toBe(true);
  });

  it('does NOT trip on a single breach under the default (needs consecutive confirmation)', () => {
    const r = new RiskMonitor(10); // default requiredBreaches = 3
    r.update(50);
    const res = r.update(40); // -10, but only one breach
    expect(res.pnl).toBe(-10);
    expect(res.tripped).toBe(false);
  });

  it('trips only after requiredBreaches consecutive breaches', () => {
    const r = new RiskMonitor(10, 3);
    r.update(50);
    expect(r.update(40).tripped).toBe(false); // breach 1
    expect(r.update(40).tripped).toBe(false); // breach 2
    expect(r.update(40).tripped).toBe(true); // breach 3 -> trip
  });

  it('a recovery resets the streak — a transient bad mark cannot trip (the Jun-12 false trip)', () => {
    const r = new RiskMonitor(10, 3);
    r.update(50);
    r.update(40); // breach 1 (e.g. a one-tick pUSD glitch)
    r.update(40); // breach 2
    expect(r.update(55).tripped).toBe(false); // good read -> streak reset
    expect(r.update(40).tripped).toBe(false); // breach 1 again, NOT 3
    expect(r.update(40).tripped).toBe(false); // breach 2
    expect(r.isTripped()).toBe(false);
  });

  it('skipped (null) reads neither advance nor reset the streak', () => {
    const r = new RiskMonitor(10, 3);
    r.update(50);
    r.update(40); // breach 1
    expect(r.update(null).tripped).toBe(false); // skipped, streak holds at 1
    r.update(40); // breach 2
    expect(r.update(40).tripped).toBe(true); // breach 3 -> trip
  });

  it('stays tripped even if equity recovers', () => {
    const r = new RiskMonitor(10, 1);
    r.update(50);
    r.update(39); // trip
    const res = r.update(55); // recovered, but latched
    expect(res.tripped).toBe(true);
  });

  it('skips null/garbage reads without setting baseline or tripping', () => {
    const r = new RiskMonitor(10);
    expect(r.update(null).tripped).toBe(false);
    expect(r.update(0).tripped).toBe(false); // 0 = reads failed
    expect(r.baseline()).toBeNull();
    // first real reading becomes the baseline
    r.update(50);
    expect(r.baseline()).toBe(50);
  });
});
