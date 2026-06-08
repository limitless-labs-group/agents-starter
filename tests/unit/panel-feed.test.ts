/**
 * PanelWriter — emits the Academy MM control panel's data contract
 * (quotes.json + positions.json + fills.ndjson + kill.flag/pull.flag).
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

const mk = () => new PanelWriter({ mode: 'live', orderSize: 25, marginBps: 100, pairs: [] }, dir);
const readJson = (p: string) => JSON.parse(fs.readFileSync(p, 'utf8'));
const readFills = (w: PanelWriter) =>
  fs.readFileSync(w.fillsPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

describe('PanelWriter', () => {
  it('starts fresh: empty quotes + positions, a run event', () => {
    const w = mk();
    expect(readJson(w.quotesPath)).toEqual([]);
    expect(readJson(w.positionsPath)).toEqual([]);
    expect(readFills(w)).toEqual([{ ts: expect.any(String), event: 'run', mode: 'live', order_size: 25 }]);
  });

  it('builds the quote board from order events (bid = YES buy, ask = 1 - NO buy, mid = poly mid)', () => {
    const w = mk();
    // poly bid 0.56 / ask 0.58, margin 1% => YES buy 0.55, NO buy 0.41
    w.onEvent({ t: 1, kind: 'order', pair: 'hurricanes', side: 'YES', price: 0.55, size: 25, orderId: 'y1' });
    w.onEvent({ t: 2, kind: 'order', pair: 'hurricanes', side: 'NO', price: 0.41, size: 25, orderId: 'n1' });
    w.onEvent({ t: 3, kind: 'snapshot', pair: 'hurricanes', net: 2, lmtsYes: 27, lmtsNo: 25, polyYes: 0, polyNo: 0 });
    const [q] = readJson(w.quotesPath);
    expect(q.bid).toEqual({ price: 0.55, shares: 25, order_id: 'y1' });
    expect(q.ask).toEqual({ price: 0.59, shares: 25, order_id: 'n1' }); // 1 - 0.41
    expect(q.mid).toBe(0.57); // (0.55 + 0.59)/2 == poly mid
    expect(q.fair_value).toBe(0.57);
    expect(q.spread).toBe(0.04); // 0.59 - 0.55
    expect(q.target_spread).toBe(0.02); // 2 * 100bps
    expect(q.net_inventory).toBe(2);
    expect(q.inventory_cap).toBe(25);
    expect(q.state).toBe('two_sided');
  });

  it('one_sided when only one leg is quoted', () => {
    const w = mk();
    w.onEvent({ t: 1, kind: 'order', pair: 'x', side: 'YES', price: 0.45, size: 25, orderId: 'y' });
    const [q] = readJson(w.quotesPath);
    expect(q.state).toBe('one_sided');
    expect(q.ask).toBeNull();
  });

  it('reflects pull.flag as pulled, and markStopped as stopped', () => {
    const w = mk();
    w.onEvent({ t: 1, kind: 'order', pair: 'x', side: 'YES', price: 0.45, size: 25, orderId: 'y' });
    w.onEvent({ t: 2, kind: 'order', pair: 'x', side: 'NO', price: 0.5, size: 25, orderId: 'n' });
    fs.writeFileSync(w.pullFlagPath, 'pulled');
    w.onEvent({ t: 3, kind: 'snapshot', pair: 'x', net: 0, lmtsYes: 0, lmtsNo: 0, polyYes: 0, polyNo: 0 });
    expect(readJson(w.quotesPath)[0].state).toBe('pulled');
    fs.rmSync(w.pullFlagPath);
    w.markStopped();
    expect(readJson(w.quotesPath)[0].state).toBe('stopped');
  });

  it('positions: per-pair net delta, P&L-neutral (no fabricated cost basis)', () => {
    const w = mk();
    w.onEvent({ t: 1, kind: 'snapshot', pair: 'a', net: -3.2, lmtsYes: 0, lmtsNo: 5, polyYes: 0, polyNo: 0 });
    const [p] = readJson(w.positionsPath);
    expect(p).toMatchObject({ slug: 'a', side: 'NO', shares: 3.2, avg_price: 0.5, mark: 0.5 });
  });

  it('only successful hedges become fills, tagged BUY/taker; churn + failures excluded', () => {
    const w = mk();
    w.onEvent({ t: 1, kind: 'order', pair: 'a', side: 'YES', price: 0.55, size: 25 }); // churn, not a fill
    w.onEvent({ t: 2, kind: 'hedge', pair: 'a', buy: 'NO', shares: 5, price: 0.44, usdc: 2.2, success: true });
    w.onEvent({ t: 3, kind: 'hedge', pair: 'a', buy: 'YES', shares: 3, price: 0.6, usdc: 1.8, success: false });
    const fills = readFills(w).filter((f) => typeof f.price === 'number' && typeof f.shares === 'number');
    expect(fills).toHaveLength(1);
    expect(fills[0]).toMatchObject({ slug: 'a', side: 'NO', action: 'BUY', liquidity: 'taker', shares: 5, price: 0.44 });
  });

  it('records hedge_skip as a non-fill learning event', () => {
    const w = mk();
    w.onEvent({
      t: 2,
      kind: 'hedge_skip',
      pair: 'a',
      reason: 'notional too small',
      buy: 'YES',
      shares: 5,
      price: 0.19,
      usdc: 0.95,
      net: -5,
      threshold: 2,
    });
    const rows = readFills(w);
    expect(rows).toContainEqual(
      expect.objectContaining({ event: 'hedge_skip', slug: 'a', reason: 'notional too small', would_usdc: 0.95 }),
    );
    expect(rows[0]).not.toHaveProperty('price');
    expect(rows[0]).not.toHaveProperty('shares');
    const fills = rows.filter((f) => typeof f.price === 'number' && typeof f.action === 'string');
    expect(fills).toHaveLength(0);
  });

  it('joins order (Limitless slug) + snapshot (Polymarket slug) into ONE quote row', () => {
    // order events key by limitlessSlug, snapshots by polymarketSlug; the pair
    // map must collapse them to one row (this is the bug local testing caught).
    const w = new PanelWriter(
      { mode: 'live', orderSize: 25, marginBps: 100, pairs: [{ polymarketSlug: 'will-x', limitlessSlug: 'x-123' }] },
      dir,
    );
    w.onEvent({ t: 1, kind: 'order', pair: 'x-123', side: 'YES', price: 0.55, size: 25, orderId: 'y' });
    w.onEvent({ t: 2, kind: 'order', pair: 'x-123', side: 'NO', price: 0.41, size: 25, orderId: 'n' });
    w.onEvent({ t: 3, kind: 'snapshot', pair: 'will-x', net: 2, lmtsYes: 0, lmtsNo: 0, polyYes: 0, polyNo: 0 });
    const q = readJson(w.quotesPath);
    expect(q).toHaveLength(1); // joined, not split into 2
    expect(q[0].slug).toBe('will-x'); // canonical = polymarket slug
    expect(q[0].bid.price).toBe(0.55);
    expect(q[0].ask.price).toBe(0.59);
    expect(q[0].net_inventory).toBe(2); // net joined onto the quoted row
    expect(q[0].state).toBe('two_sided');
  });

  it('kill.flag: writes + detects', () => {
    const w = mk();
    expect(w.killFlagExists()).toBe(false);
    w.writeKillFlag('breaker');
    expect(w.killFlagExists()).toBe(true);
  });
});
