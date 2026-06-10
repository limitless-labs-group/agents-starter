/**
 * Cross-market MM diff requoter.
 *
 * Strategy invariants under test:
 *   - Unchanged whole-cent quotes with both orders confirmed (or trusted)
 *     resting -> skip, preserving price-time queue position.
 *   - Exactly one side moved -> replace only that side.
 *   - Any uncertainty (no confirmed placement, a consumed order) degrades to
 *     cancel-all + replace, the pre-diff behavior.
 */

import { describe, expect, it } from 'vitest';
import { planRequote, type QuoteMemo } from '../../src/strategies/cross-market-mm/index.js';

const memo = (yes?: [number, string?], no?: [number, string?]): QuoteMemo => ({
  yes: yes ? { cents: yes[0], orderId: yes[1] } : undefined,
  no: no ? { cents: no[0], orderId: no[1] } : undefined,
});

const placed = memo([77, 'y1'], [21, 'n1']);

describe('planRequote', () => {
  it('skips when neither side moved and both orders are confirmed live', () => {
    expect(planRequote(77, 21, placed, true)).toEqual({ action: 'skip' });
  });

  it('skips between liveness checks (bothLive null trusts the memo)', () => {
    expect(planRequote(77, 21, placed, null)).toEqual({ action: 'skip' });
  });

  it('replaces all when a resting order is gone (filled or cancelled)', () => {
    expect(planRequote(77, 21, placed, false)).toEqual({ action: 'replace_all' });
  });

  it('replaces only the side that moved on the cent grid', () => {
    expect(planRequote(78, 21, placed, true)).toEqual({ action: 'replace_side', side: 'YES' });
    expect(planRequote(77, 22, placed, true)).toEqual({ action: 'replace_side', side: 'NO' });
    expect(planRequote(78, 21, placed, null)).toEqual({ action: 'replace_side', side: 'YES' });
  });

  it('replaces all when both sides moved', () => {
    expect(planRequote(78, 22, placed, true)).toEqual({ action: 'replace_all' });
  });

  it('replaces all without a confirmed placement on every side', () => {
    expect(planRequote(77, 21, memo(), true)).toEqual({ action: 'replace_all' });
    expect(planRequote(77, 21, memo([77, 'y1']), true)).toEqual({ action: 'replace_all' });
    // a placement without an order id cannot be single-side cancelled
    expect(planRequote(77, 21, memo([77, 'y1'], [21]), true)).toEqual({ action: 'replace_all' });
  });

  it('a gone order wins over a single-side move (no doubling a side)', () => {
    expect(planRequote(78, 21, placed, false)).toEqual({ action: 'replace_all' });
  });
});
