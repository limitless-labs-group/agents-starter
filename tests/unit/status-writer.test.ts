/**
 * StatusWriter — folds the event stream into a live JSON snapshot on disk.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StatusWriter, type LiveStatus } from '../../src/strategies/cross-market-mm/status-writer.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmm-status-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const read = (w: StatusWriter): LiveStatus => JSON.parse(fs.readFileSync(w.filePath, 'utf8'));

describe('StatusWriter', () => {
  it('writes an initial snapshot on construct', () => {
    const w = new StatusWriter({ mode: 'live', pairs: 2, orderSize: 25, maxLossUsd: 30 }, dir);
    const s = read(w);
    expect(s.mode).toBe('live');
    expect(s.pairs).toBe(2);
    expect(s.breaker.maxLossUsd).toBe(30);
    expect(s.breaker.tripped).toBe(false);
    expect(s.skippedHedges).toBe(0);
    expect(s.lastHedgeSkip).toBeNull();
    expect(s.pnl).toBeNull();
    expect(s.stopped).toBeNull();
  });

  it('folds snapshot/equity/hedge events into the snapshot', () => {
    const w = new StatusWriter({ mode: 'live', pairs: 1, orderSize: 5, maxLossUsd: 10 }, dir);
    w.onEvent({ t: 1, kind: 'snapshot', pair: 'btc-up', net: -1.2, lmtsYes: 0, lmtsNo: 0, polyYes: 0, polyNo: 0 });
    w.onEvent({ t: 2, kind: 'equity', pnl: -0.5, equity: 199.5, pUSD: 0, lmtsFreeUsd: 0, posValue: 0 });
    w.onEvent({ t: 3, kind: 'hedge', pair: 'btc-up', buy: 'NO', shares: 5, price: 0.44, usdc: 2.2, success: true });

    const s = read(w);
    expect(s.net).toEqual([{ pair: 'btc-up', net: -1.2 }]);
    expect(s.pnl).toBe(-0.5);
    expect(s.equity).toBe(199.5);
    expect(s.hedges).toBe(1);
    expect(s.lastFill).toMatchObject({ pair: 'btc-up', buy: 'NO', shares: 5, usd: 2.2 });
  });

  it('does not count a failed hedge as a fill', () => {
    const w = new StatusWriter({ mode: 'live', pairs: 1, orderSize: 5, maxLossUsd: 10 }, dir);
    w.onEvent({ t: 1, kind: 'hedge', pair: 'btc-up', buy: 'NO', shares: 5, price: 0.44, usdc: 2.2, success: false });
    const s = read(w);
    expect(s.hedges).toBe(0);
    expect(s.lastFill).toBeNull();
  });

  it('folds hedge_skip events into the snapshot', () => {
    const w = new StatusWriter({ mode: 'live', pairs: 1, orderSize: 5, maxLossUsd: 10 }, dir);
    w.onEvent({
      t: 4,
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
    const s = read(w);
    expect(s.skippedHedges).toBe(1);
    expect(s.lastHedgeSkip).toMatchObject({ pair: 'btc-up', reason: 'notional too small', usd: 0.95, net: -5 });
  });

  it('records breaker trip and stop', () => {
    const w = new StatusWriter({ mode: 'live', pairs: 1, orderSize: 5, maxLossUsd: 10 }, dir);
    w.markTripped();
    expect(read(w).breaker.tripped).toBe(true);
    w.markStopped('circuit-breaker', false);
    const s = read(w);
    expect(s.stopped).toMatchObject({ reason: 'circuit-breaker', flat: false });
  });
});
