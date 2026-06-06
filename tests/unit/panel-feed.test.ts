/**
 * PanelWriter — emits the Academy control panel's data contract.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PanelWriter } from '../../src/strategies/cross-market-mm/panel-feed.js';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmm-panel-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const readPositions = (w: PanelWriter) => JSON.parse(fs.readFileSync(w.positionsPath, 'utf8'));
const readFills = (w: PanelWriter) =>
  fs
    .readFileSync(w.fillsPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));

describe('PanelWriter', () => {
  it('starts a fresh feed with a run event and empty positions', () => {
    const w = new PanelWriter({ mode: 'dry', orderSize: 25 }, dir);
    expect(readPositions(w)).toEqual([]);
    const fills = readFills(w);
    expect(fills).toHaveLength(1);
    expect(fills[0]).toMatchObject({ event: 'run', mode: 'dry', order_size: 25 });
  });

  it('renders per-pair net delta as a position (side = direction, shares = |net|, P&L-neutral)', () => {
    const w = new PanelWriter({ mode: 'live', orderSize: 25 }, dir);
    w.onEvent({ t: 1, kind: 'snapshot', pair: 'btc-up', net: 0, lmtsYes: 5, lmtsNo: 5, polyYes: 0, polyNo: 0 });
    w.onEvent({ t: 2, kind: 'snapshot', pair: 'eth-up', net: -3.2, lmtsYes: 0, lmtsNo: 5, polyYes: 0, polyNo: 0 });
    const pos = readPositions(w);
    expect(pos).toContainEqual({ slug: 'btc-up', title: 'btc-up', side: 'YES', shares: 0, avg_price: 0.5, mark: 0.5 });
    expect(pos).toContainEqual({ slug: 'eth-up', title: 'eth-up', side: 'NO', shares: 3.2, avg_price: 0.5, mark: 0.5 });
    // avg == mark => the panel computes per-row P&L of 0 (no fabricated cost basis)
    for (const p of pos) expect(p.avg_price).toBe(p.mark);
  });

  it('writes only successful hedges as fills (numeric price+shares); skips failed + never writes quote churn', () => {
    const w = new PanelWriter({ mode: 'live', orderSize: 25 }, dir);
    w.onEvent({ t: 1, kind: 'order', pair: 'btc-up', side: 'YES', price: 0.55, size: 25 }); // quote churn -> not a fill
    w.onEvent({ t: 2, kind: 'hedge', pair: 'btc-up', buy: 'NO', shares: 5, price: 0.44, usdc: 2.2, success: true });
    w.onEvent({ t: 3, kind: 'hedge', pair: 'btc-up', buy: 'YES', shares: 3, price: 0.6, usdc: 1.8, success: false });
    const fills = readFills(w).filter((f) => typeof f.price === 'number' && typeof f.shares === 'number');
    expect(fills).toHaveLength(1);
    expect(fills[0]).toMatchObject({ slug: 'btc-up', side: 'NO', shares: 5, price: 0.44 });
  });

  it('kill.flag: writes (panel shows TRIPPED) and detects existence', () => {
    const w = new PanelWriter({ mode: 'live', orderSize: 25 }, dir);
    expect(w.killFlagExists()).toBe(false);
    w.writeKillFlag('breaker');
    expect(w.killFlagExists()).toBe(true);
    expect(fs.existsSync(path.join(dir, 'kill.flag'))).toBe(true);
  });

  it('appendEvent lands a non-fill {event} row the panel renders as an event', () => {
    const w = new PanelWriter({ mode: 'live', orderSize: 25 }, dir);
    w.appendEvent('stopped', { reason: 'circuit-breaker', flat: true });
    const last = readFills(w).at(-1);
    expect(last).toMatchObject({ event: 'stopped', reason: 'circuit-breaker', flat: true });
    // not a fill: no numeric price+shares
    expect(typeof last.price).not.toBe('number');
  });
});
