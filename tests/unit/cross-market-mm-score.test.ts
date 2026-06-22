/**
 * Experiment-loop scorer (score.ts). Pure scoring over parsed run events —
 * no filesystem, no network. The CLI wrapper (ledger append, printing) is not
 * exercised here; scoreEvents is the testable core.
 */

import { describe, it, expect } from 'vitest';
import { scoreEvents } from '../../src/strategies/cross-market-mm/score.js';
import type { TimestampedEvent } from '../../src/strategies/cross-market-mm/recorder.js';

/** A run that fills 3 YES, hedges it successfully, returns flat, bleeds $0.40. */
function filledRun(): TimestampedEvent[] {
  return [
    { t: 1000, kind: 'run', dryRun: false, pairs: 1, orderSize: 6, marginBps: 100 },
    { t: 1001, kind: 'snapshot', pair: 'p', net: 0, lmtsYes: 0, lmtsNo: 0, polyYes: 0.5, polyNo: 0.5 },
    { t: 1002, kind: 'snapshot', pair: 'p', net: 3, lmtsYes: 3, lmtsNo: 0, polyYes: 0.5, polyNo: 0.5 },
    { t: 1002, kind: 'hedge', pair: 'p', buy: 'NO', shares: 3, price: 0.5, usdc: 1.5, success: true },
    { t: 1003, kind: 'snapshot', pair: 'p', net: 0, lmtsYes: 3, lmtsNo: 0, polyYes: 0.5, polyNo: 0.5 },
    { t: 1004, kind: 'snapshot', pair: 'p', net: 0, lmtsYes: 3, lmtsNo: 0, polyYes: 0.5, polyNo: 0.5 },
    { t: 1005, kind: 'equity', pnl: -0.4, equity: 629.6, pUSD: 100, lmtsFreeUsd: 500, posValue: 29.6 },
  ];
}

describe('scoreEvents — scored path', () => {
  it('computes the transparent weighted sum from the components', () => {
    // 40*1(hedge) + 25*0.75(flat 3/4) + 15*0.3(3 fills/cap10) - 5*0.4(bleed) - 5*0.5(inv 3/6) - 0
    const r = scoreEvents(filledRun(), 0, 'run.jsonl');
    expect(r.verdict).toBe('ok');
    expect(r.score).toBeCloseTo(58.75, 5);
    expect(r.mode).toBe('LIVE');
    expect(r.components.hedgeRate).toBe(1);
    expect(r.components.flatFrac).toBeCloseTo(0.75, 5);
    expect(r.components.fills).toBeCloseTo(3, 5);
    expect(r.components.bleedUsd).toBeCloseTo(0.4, 5);
    expect(r.components.inventoryMult).toBeCloseTo(0.5, 5);
  });

  it('penalizes each operator intervention by 20', () => {
    const r = scoreEvents(filledRun(), 1, 'run.jsonl');
    expect(r.score).toBeCloseTo(58.75 - 20, 5);
  });

  it('penalizes a failed hedge (hedge rate drops)', () => {
    const evs = filledRun().map((e) => (e.kind === 'hedge' ? { ...e, success: false } : e));
    const r = scoreEvents(evs, 0, 'run.jsonl');
    // hedgeRate 0 removes the +40 term: 58.75 - 40 = 18.75
    expect(r.score).toBeCloseTo(18.75, 5);
  });
});

describe('scoreEvents — inconclusive guard (anti-Goodhart)', () => {
  it('marks a no-fill run inconclusive even when 100% flat + 100% hedge', () => {
    const evs: TimestampedEvent[] = [
      { t: 1000, kind: 'run', dryRun: true, pairs: 1, orderSize: 6, marginBps: 100 },
      { t: 1001, kind: 'snapshot', pair: 'p', net: 0, lmtsYes: 0, lmtsNo: 0, polyYes: 0.5, polyNo: 0.5 },
      { t: 1002, kind: 'snapshot', pair: 'p', net: 0, lmtsYes: 0, lmtsNo: 0, polyYes: 0.5, polyNo: 0.5 },
    ];
    const r = scoreEvents(evs, 0, 'run.jsonl');
    expect(r.verdict).toBe('inconclusive');
    expect(r.score).toBeNull();
    expect(r.mode).toBe('DRY');
  });
});
