/**
 * Fill → hedge round-trip (the core replicator mechanic), deterministic.
 *
 * A live fill needs an external Limitless taker, which is market-gated and
 * not reproducible on demand. This proves the pipeline that fires once a fill
 * lands: a Limitless position (the fill) makes hedgeOnce detect net exposure,
 * fire the correct Polymarket hedge (right asset + direction + notional), and
 * record a 'hedge' event — exactly what would show up in ./data live.
 */

import { describe, it, expect, vi } from 'vitest';
import { hedgeOnce } from '../../src/strategies/replicator/hedger.js';
import { QuoteFeed } from '../../src/strategies/replicator/quote-feed.js';
import type { PolymarketAdapter } from '../../src/core/polymarket/client.js';
import type { ReplicatorSettings, MarketPair } from '../../src/strategies/replicator/types.js';
import type { ReplicatorEvent } from '../../src/strategies/replicator/recorder.js';

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

  it('an already-hedged position (Limitless YES offset by Poly NO) does NOT hedge', async () => {
    const hedgeBuy = vi.fn().mockResolvedValue(true);
    const poly = { hedgeBuy } as unknown as PolymarketAdapter;
    const lmts = { [PAIR.limitlessSlug]: { yes: 5, no: 0 } };
    const polyPos = new Map([[PAIR.polymarketSlug, { yes: 0, no: 5 }]]); // net 0

    await hedgeOnce([PAIR], feedWithQuote(0.6, 0.62), lmts, polyPos, poly, SETTINGS);

    expect(hedgeBuy).not.toHaveBeenCalled();
  });
});
