/**
 * The settlementStatus state machine, as documented for POST /orders:
 * branch on `execution.settlementStatus`, never on `matched`.
 */
import { describe, it, expect } from 'vitest';
import { classifyExecution, isTerminalState, summarizeExecution } from '../../src/core/limitless/execution.js';
import type { OrderResponse } from '@limitless-exchange/sdk';

describe('classifyExecution', () => {
  it('MINED / CONFIRMED are filled for every order type', () => {
    for (const t of ['GTC', 'FOK', 'FAK'] as const) {
      expect(classifyExecution('MINED', t)).toBe('filled');
      expect(classifyExecution('CONFIRMED', t)).toBe('filled');
    }
  });

  it('UNMATCHED means resting for GTC but killed for FOK/FAK', () => {
    expect(classifyExecution('UNMATCHED', 'GTC')).toBe('resting');
    expect(classifyExecution('UNMATCHED', 'FOK')).toBe('killed');
    expect(classifyExecution('UNMATCHED', 'FAK')).toBe('killed');
  });

  it('DELAYED (taker delay) is pending, not an error', () => {
    expect(classifyExecution('DELAYED', 'FOK')).toBe('pending');
    expect(classifyExecution('MATCHED', 'FAK')).toBe('pending');
    expect(classifyExecution('RETRYING', 'GTC')).toBe('pending');
  });

  it('CANCELED (STP) is killed, FAILED is failed, unknown strings are unknown', () => {
    expect(classifyExecution('CANCELED', 'FOK')).toBe('killed');
    expect(classifyExecution('FAILED', 'GTC')).toBe('failed');
    expect(classifyExecution('SOMETHING_NEW', 'GTC')).toBe('unknown');
    expect(classifyExecution(undefined, 'GTC')).toBe('unknown');
  });

  it('terminal states are filled / killed / failed only', () => {
    expect(isTerminalState('filled')).toBe(true);
    expect(isTerminalState('killed')).toBe(true);
    expect(isTerminalState('failed')).toBe(true);
    expect(isTerminalState('pending')).toBe(false);
    expect(isTerminalState('resting')).toBe(false);
    expect(isTerminalState('unknown')).toBe(false);
  });
});

describe('summarizeExecution', () => {
  const mined: OrderResponse = {
    order: { id: 'o1' } as OrderResponse['order'],
    execution: {
      effectiveFeeBps: 120,
      feeRateBps: 300,
      matched: true,
      settlementStatus: 'MINED',
      txHash: '0xabc',
      totalsRaw: {
        contractsGross: '10000000',
        contractsFee: '120000',
        contractsNet: '9880000',
        usdGross: '4000000',
        usdFee: '0',
        usdNet: '4000000',
      },
    },
  };

  it('converts raw totals to human units and derives the average fill price', () => {
    const s = summarizeExecution(mined, 'FOK');
    expect(s.state).toBe('filled');
    expect(s.contracts).toBeCloseTo(9.88, 6);
    expect(s.usd).toBeCloseTo(4, 6);
    expect(s.avgPrice).toBeCloseTo(0.4, 6); // usdGross / contractsGross
    expect(s.effectiveFeeBps).toBe(120);
    expect(s.txHash).toBe('0xabc');
  });

  it('surfaces eligibleAt on a DELAYED taker order', () => {
    const delayed: OrderResponse = {
      order: { id: 'o2' } as OrderResponse['order'],
      execution: {
        effectiveFeeBps: 0,
        feeRateBps: 300,
        matched: false,
        settlementStatus: 'DELAYED',
        eligibleAt: '2026-09-11T12:00:01.250Z',
        totalsRaw: { contractsGross: '0', contractsFee: '0', contractsNet: '0', usdGross: '0', usdFee: '0', usdNet: '0' },
      },
    };
    const s = summarizeExecution(delayed, 'FOK');
    expect(s.state).toBe('pending');
    expect(s.eligibleAt).toBe('2026-09-11T12:00:01.250Z');
    expect(s.avgPrice).toBeNull();
  });

  it('handles a missing execution object (dry run) as unknown', () => {
    const s = summarizeExecution({ order: { id: 'dry' } as OrderResponse['order'] }, 'GTC');
    expect(s.state).toBe('unknown');
    expect(s.contracts).toBe(0);
  });
});
