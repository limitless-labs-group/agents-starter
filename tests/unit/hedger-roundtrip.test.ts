/**
 * Fill → hedge round-trip (the core cross-market-mm mechanic), deterministic.
 *
 * A live fill needs an external Limitless taker, which is market-gated and
 * not reproducible on demand. This proves the pipeline that fires once a fill
 * lands: a Limitless position (the fill) makes hedgeOnce detect net exposure,
 * fire the correct Polymarket hedge (right asset + direction + notional), and
 * record a 'hedge' event — exactly what would show up in ./data live.
 */

import { describe, it, expect, vi } from 'vitest';
import { hedgeOnce } from '../../src/strategies/cross-market-mm/hedger.js';
import { QuoteFeed } from '../../src/strategies/cross-market-mm/quote-feed.js';
import type { PolymarketAdapter } from '../../src/core/polymarket/client.js';
import type { ReplicatorSettings, MarketPair } from '../../src/strategies/cross-market-mm/types.js';
import type { ReplicatorEvent } from '../../src/strategies/cross-market-mm/recorder.js';

const PAIR: MarketPair = {
  polymarketSlug: 'poly-x',
  limitlessSlug: 'lmts-x',
  polyYesAssetId: 'POLY_YES',
  polyNoAssetId: 'POLY_NO',
};

const SETTINGS = {
  hedgeThreshold: 2,
  marginBps: 100,
  orderSize: 5,
} as unknown as ReplicatorSettings;

function feedWithQuote(bid: number, ask: number): QuoteFeed {
  const feed = new QuoteFeed();
  feed.update(PAIR.polymarketSlug, bid, ask);
  return feed;
}

/** Records every event passed to it. */
function fakeRecorder() {
  const events: ReplicatorEvent[] = [];
  return { events, record: (e: ReplicatorEvent) => events.push(e), close: () => {}, filePath: '' };
}

describe('fill → hedge round-trip (hedgeOnce)', () => {
  it('a long-YES Limitless fill fires a NO buy on Polymarket + records it', async () => {
    const hedgeBuy = vi.fn().mockResolvedValue(true);
    const poly = { hedgeBuy } as unknown as PolymarketAdapter;
    const rec = fakeRecorder();

    // Simulate a fill: we now hold 5 YES on Limitless, flat on Poly.
    const lmts = { [PAIR.limitlessSlug]: { yes: 5, no: 0 } };
    const polyPos = new Map([[PAIR.polymarketSlug, { yes: 0, no: 0 }]]);

    await hedgeOnce([PAIR], feedWithQuote(0.6, 0.62), lmts, polyPos, poly, SETTINGS, rec);

    // Long YES (net +5 > threshold) → buy NO on Polymarket.
    expect(hedgeBuy).toHaveBeenCalledTimes(1);
    const [assetId, usdc] = hedgeBuy.mock.calls[0];
    expect(assetId).toBe('POLY_NO');
    expect(usdc).toBeGreaterThan(0);

    // The round-trip is recorded for ./data / analyze.
    const hedge = rec.events.find((e) => e.kind === 'hedge') as Extract<ReplicatorEvent, { kind: 'hedge' }>;
    expect(hedge).toBeTruthy();
    expect(hedge.buy).toBe('NO');
    expect(hedge.success).toBe(true);
    // And a snapshot of the (pre-hedge) exposure is recorded too.
    expect(rec.events.some((e) => e.kind === 'snapshot')).toBe(true);
  });

  it('a long-NO fill fires a YES buy on Polymarket', async () => {
    const hedgeBuy = vi.fn().mockResolvedValue(true);
    const poly = { hedgeBuy } as unknown as PolymarketAdapter;
    const lmts = { [PAIR.limitlessSlug]: { yes: 0, no: 5 } };
    const polyPos = new Map([[PAIR.polymarketSlug, { yes: 0, no: 0 }]]);

    await hedgeOnce([PAIR], feedWithQuote(0.6, 0.62), lmts, polyPos, poly, SETTINGS);

    expect(hedgeBuy).toHaveBeenCalledTimes(1);
    expect(hedgeBuy.mock.calls[0][0]).toBe('POLY_YES');
  });

  it('records threshold-crossing hedge skips with the reason and notional', async () => {
    const hedgeBuy = vi.fn().mockResolvedValue(true);
    const poly = { hedgeBuy } as unknown as PolymarketAdapter;
    const rec = fakeRecorder();
    const lmts = { [PAIR.limitlessSlug]: { yes: 0, no: 5 } };
    const polyPos = new Map([[PAIR.polymarketSlug, { yes: 0, no: 0 }]]);

    await hedgeOnce([PAIR], feedWithQuote(0.6, 0.19), lmts, polyPos, poly, SETTINGS, rec);

    expect(hedgeBuy).not.toHaveBeenCalled();
    const skip = rec.events.find((e) => e.kind === 'hedge_skip') as Extract<ReplicatorEvent, { kind: 'hedge_skip' }>;
    expect(skip).toMatchObject({ reason: 'notional too small', buy: 'YES', shares: 5 });
    expect(skip.usdc).toBeCloseTo(0.95, 6);
  });

  it('an already-hedged position (Limitless YES offset by Poly NO) does NOT hedge', async () => {
    const hedgeBuy = vi.fn().mockResolvedValue(true);
    const poly = { hedgeBuy } as unknown as PolymarketAdapter;
    const lmts = { [PAIR.limitlessSlug]: { yes: 5, no: 0 } };
    const polyPos = new Map([[PAIR.polymarketSlug, { yes: 0, no: 5 }]]); // net 0

    await hedgeOnce([PAIR], feedWithQuote(0.6, 0.62), lmts, polyPos, poly, SETTINGS);

    expect(hedgeBuy).not.toHaveBeenCalled();
  });

  it('settle gate: a stale (pre-hedge) re-read does NOT re-fire the same hedge', async () => {
    // Live bug this guards: hedgeIntervalSec (5s) < Poly data-api settle lag, so
    // the next tick re-reads the OLD position (hedge not yet reflected) and
    // would stack a duplicate hedge. The gate must suppress that within
    // hedgeSettleMs, then allow it once the window passes.
    const settings = { hedgeThreshold: 2, marginBps: 100, orderSize: 5, hedgeSettleMs: 12000 } as unknown as ReplicatorSettings;
    const hedgeBuy = vi.fn().mockResolvedValue(true);
    const poly = { hedgeBuy } as unknown as PolymarketAdapter;
    const lastHedgeAt = new Map<string, number>(); // shared across ticks, like runHedger

    // The fill: long 5 YES, Poly still flat (lagged read shows no hedge yet).
    const lmts = { [PAIR.limitlessSlug]: { yes: 5, no: 0 } };
    const stalePoly = new Map([[PAIR.polymarketSlug, { yes: 0, no: 0 }]]);

    // Tick 1: fires the NO hedge.
    await hedgeOnce([PAIR], feedWithQuote(0.6, 0.62), lmts, stalePoly, poly, settings, undefined, lastHedgeAt);
    expect(hedgeBuy).toHaveBeenCalledTimes(1);

    // Tick 2 (immediately): same stale read → would re-hedge, but gate holds it.
    await hedgeOnce([PAIR], feedWithQuote(0.6, 0.62), lmts, stalePoly, poly, settings, undefined, lastHedgeAt);
    expect(hedgeBuy).toHaveBeenCalledTimes(1); // still 1 — not stacked

    // Once the settle window passes and the position is genuinely still exposed,
    // hedging is allowed again.
    lastHedgeAt.set(PAIR.polymarketSlug, Date.now() - 13_000);
    await hedgeOnce([PAIR], feedWithQuote(0.6, 0.62), lmts, stalePoly, poly, settings, undefined, lastHedgeAt);
    expect(hedgeBuy).toHaveBeenCalledTimes(2);
  });
});

const GUARD_SETTINGS = {
  hedgeThreshold: 2,
  marginBps: 100,
  orderSize: 5,
  hedgeSettleMs: 0, // no settle gate, so repeated ticks each fire a hedge
  maxNetShares: 10,
  maxHedgeFailures: 3,
} as unknown as ReplicatorSettings;

describe('inventory guard (hedgeOnce)', () => {
  it('pulls quotes when |net| reaches max_net_shares, still hedging the pile down', async () => {
    const onPull = vi.fn();
    const hedgeBuy = vi.fn().mockResolvedValue(true);
    const poly = { hedgeBuy } as unknown as PolymarketAdapter;
    const rec = fakeRecorder();
    const lmts = { [PAIR.limitlessSlug]: { yes: 12, no: 0 } }; // net +12 >= cap 10
    const polyPos = new Map([[PAIR.polymarketSlug, { yes: 0, no: 0 }]]);

    await hedgeOnce([PAIR], feedWithQuote(0.6, 0.62), lmts, polyPos, poly, GUARD_SETTINGS, rec, new Map(), new Map(), onPull);

    expect(onPull).toHaveBeenCalledTimes(1);
    expect(onPull.mock.calls[0][0]).toMatch(/inventory cap/);
    expect(hedgeBuy).toHaveBeenCalled(); // still flattens what we hold
    expect(
      rec.events.some((e) => e.kind === 'hedge_skip' && /inventory cap/.test((e as { reason?: string }).reason ?? '')),
    ).toBe(true);
  });

  it('does NOT pull while under the cap', async () => {
    const onPull = vi.fn();
    const poly = { hedgeBuy: vi.fn().mockResolvedValue(true) } as unknown as PolymarketAdapter;
    const lmts = { [PAIR.limitlessSlug]: { yes: 5, no: 0 } }; // net +5 < cap 10
    const polyPos = new Map([[PAIR.polymarketSlug, { yes: 0, no: 0 }]]);
    await hedgeOnce([PAIR], feedWithQuote(0.6, 0.62), lmts, polyPos, poly, GUARD_SETTINGS, undefined, new Map(), new Map(), onPull);
    expect(onPull).not.toHaveBeenCalled();
  });

  it('pulls after max_hedge_failures consecutive failed hedges, and a success resets the streak', async () => {
    const onPull = vi.fn();
    const hedgeBuy = vi.fn().mockResolvedValue(false); // broken Poly route
    const poly = { hedgeBuy } as unknown as PolymarketAdapter;
    const lmts = { [PAIR.limitlessSlug]: { yes: 5, no: 0 } }; // net +5: hedges, under cap
    const polyPos = new Map([[PAIR.polymarketSlug, { yes: 0, no: 0 }]]);
    const failStreak = new Map<string, number>();
    const lastHedge = new Map<string, number>();
    const feed = feedWithQuote(0.6, 0.62);
    const tick = () =>
      hedgeOnce([PAIR], feed, lmts, polyPos, poly, GUARD_SETTINGS, undefined, lastHedge, failStreak, onPull);

    await tick();
    expect(onPull).not.toHaveBeenCalled(); // 1 fail
    await tick();
    expect(onPull).not.toHaveBeenCalled(); // 2 fails
    await tick();
    expect(onPull).toHaveBeenCalledTimes(1); // 3 fails -> pull
    expect(onPull.mock.calls[0][0]).toMatch(/hedge failed/);

    hedgeBuy.mockResolvedValue(true);
    await tick();
    expect(failStreak.get(PAIR.polymarketSlug)).toBe(0); // success resets
  });
});
