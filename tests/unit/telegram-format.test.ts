/**
 * Cross-market-mm Telegram formatters — pure string output.
 */

import { describe, expect, it } from 'vitest';
import {
  fmtStarted,
  fmtHedge,
  fmtHedgeSkip,
  fmtHeartbeat,
  fmtHalted,
} from '../../src/strategies/cross-market-mm/telegram.js';

describe('fmtStarted', () => {
  it('marks live runs and pluralizes pairs', () => {
    const s = fmtStarted({ live: true, pairs: 2, orderSize: 25, maxLossUsd: 30 });
    expect(s).toContain('live');
    expect(s).toContain('2 pairs');
    expect(s).toContain('order_size 25');
    expect(s).toContain('-$30');
  });

  it('marks dry runs and singular pair', () => {
    const s = fmtStarted({ live: false, pairs: 1, orderSize: 5, maxLossUsd: 10 });
    expect(s).toContain('dry run');
    expect(s).toContain('1 pair');
    expect(s).not.toContain('1 pairs');
  });
});

describe('fmtHedge', () => {
  it('renders a successful fill→hedge', () => {
    const s = fmtHedge({ kind: 'hedge', pair: 'btc-up', buy: 'NO', shares: 5, price: 0.44, usdc: 2.2, success: true });
    expect(s).toContain('Fill → hedged');
    expect(s).toContain('btc-up');
    expect(s).toContain('5.00 NO');
    expect(s).toContain('$2.20');
  });

  it('flags a failed hedge', () => {
    const s = fmtHedge({ kind: 'hedge', pair: 'btc-up', buy: 'YES', shares: 3, price: 0.6, usdc: 1.8, success: false });
    expect(s).toContain('Hedge failed');
  });
});

describe('fmtHedgeSkip', () => {
  it('renders a skipped hedge reason with net and would-buy details', () => {
    const s = fmtHedgeSkip({
      kind: 'hedge_skip',
      pair: 'btc-up',
      reason: 'notional too small',
      buy: 'YES',
      shares: 5,
      price: 0.19,
      usdc: 0.95,
      net: -5,
      threshold: 2,
    });
    expect(s).toContain('Hedge skipped');
    expect(s).toContain('notional too small');
    expect(s).toContain('net -5.00');
    expect(s).toContain('$0.95');
  });
});

describe('fmtHeartbeat', () => {
  it('signs pnl and lists per-pair net', () => {
    const s = fmtHeartbeat({
      elapsedMs: 5 * 60_000,
      pnl: -1.5,
      equity: 198.5,
      net: [['btc-up', 0], ['eth-up', -1.2]],
      hedges: 3,
    });
    expect(s).toContain('5m');
    expect(s).toContain('-1.50');
    expect(s).toContain('198.50');
    expect(s).toContain('3 hedges');
    expect(s).toContain('btc-up');
    expect(s).toContain('-1.20');
  });

  it('handles no snapshots yet', () => {
    const s = fmtHeartbeat({ elapsedMs: 0, pnl: 0, equity: 0, net: [], hedges: 0 });
    expect(s).toContain('no snapshots yet');
    expect(s).toContain('0 hedges');
  });
});

describe('fmtHalted', () => {
  it('distinguishes breaker from signal', () => {
    expect(fmtHalted('circuit-breaker', true)).toContain('circuit breaker');
    expect(fmtHalted('signal', true)).not.toContain('circuit breaker');
  });

  it('reports flat state, and omits it when unknown (dry run)', () => {
    expect(fmtHalted('signal', true)).toContain('flat on both venues');
    expect(fmtHalted('signal', false)).toContain('NOT fully flat');
    const dry = fmtHalted('signal', null);
    expect(dry).not.toContain('flat on both venues');
    expect(dry).not.toContain('NOT fully flat');
  });
});
