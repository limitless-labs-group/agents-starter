/**
 * Hedge-skip dedupe — the 20k-skip watchdog spam (Jun-29).
 *
 * A −2.45-share Argentina residual was above the share threshold but only ~$0.51
 * notional, below Polymarket's $1 minimum, so it could never be hedged. The hedger
 * recorded a 'notional too small' hedge_skip every tick (20,000+), flooding the
 * JSONL and the watchdog. The fix: a persistent unchanged skip surfaces once, and
 * re-surfaces only when the reason or net materially changes.
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
const SETTINGS = { hedgeThreshold: 2, marginBps: 100, orderSize: 5 } as unknown as ReplicatorSettings;

function feedWithQuote(bid: number, ask: number): QuoteFeed {
  const feed = new QuoteFeed();
  feed.update(PAIR.polymarketSlug, bid, ask);
  return feed;
}
function fakeRecorder() {
  const events: ReplicatorEvent[] = [];
  return { events, record: (e: ReplicatorEvent) => events.push(e), close: () => {}, filePath: '' };
}
const skips = (r: ReturnType<typeof fakeRecorder>) => r.events.filter((e) => e.kind === 'hedge_skip');

describe('hedge-skip dedupe', () => {
  it('records a persistent sub-$1 residual skip ONCE across many ticks', async () => {
    const poly = { hedgeBuy: vi.fn() } as unknown as PolymarketAdapter;
    const rec = fakeRecorder();
    const sig = new Map<string, string>();
    // net -2.45 (short), YES ~0.20 -> ~$0.49 hedge notional < $1 -> 'notional too small'
    const lmts = { [PAIR.limitlessSlug]: { yes: 0, no: 2.45 } };
    const pm = new Map([[PAIR.polymarketSlug, { yes: 0, no: 0 }]]);
    const feed = feedWithQuote(0.19, 0.21);

    for (let i = 0; i < 10; i++) {
      await hedgeOnce([PAIR], feed, lmts, pm, poly, SETTINGS, rec, new Map(), new Map(), undefined, sig);
    }

    expect(skips(rec)).toHaveLength(1); // not 10
    expect((skips(rec)[0] as Extract<ReplicatorEvent, { kind: 'hedge_skip' }>).reason).toBe('notional too small');
    expect(poly.hedgeBuy).not.toHaveBeenCalled(); // never placed (sub-$1)
  });

  it('re-surfaces when the residual materially changes', async () => {
    const poly = { hedgeBuy: vi.fn() } as unknown as PolymarketAdapter;
    const rec = fakeRecorder();
    const sig = new Map<string, string>();
    const pm = new Map([[PAIR.polymarketSlug, { yes: 0, no: 0 }]]);
    const feed = feedWithQuote(0.19, 0.21);

    await hedgeOnce([PAIR], feed, { [PAIR.limitlessSlug]: { yes: 0, no: 2.45 } }, pm, poly, SETTINGS, rec, new Map(), new Map(), undefined, sig);
    await hedgeOnce([PAIR], feed, { [PAIR.limitlessSlug]: { yes: 0, no: 2.45 } }, pm, poly, SETTINGS, rec, new Map(), new Map(), undefined, sig); // same → suppressed
    await hedgeOnce([PAIR], feed, { [PAIR.limitlessSlug]: { yes: 0, no: 4.0 } }, pm, poly, SETTINGS, rec, new Map(), new Map(), undefined, sig); // grew → new skip

    expect(skips(rec)).toHaveLength(2); // first + the changed one, not three
  });

  it('clears the dedupe when the residual goes back under threshold', async () => {
    const poly = { hedgeBuy: vi.fn() } as unknown as PolymarketAdapter;
    const rec = fakeRecorder();
    const sig = new Map<string, string>();
    const pm = new Map([[PAIR.polymarketSlug, { yes: 0, no: 0 }]]);
    const feed = feedWithQuote(0.19, 0.21);

    await hedgeOnce([PAIR], feed, { [PAIR.limitlessSlug]: { yes: 0, no: 2.45 } }, pm, poly, SETTINGS, rec, new Map(), new Map(), undefined, sig); // skip
    await hedgeOnce([PAIR], feed, { [PAIR.limitlessSlug]: { yes: 0, no: 1.0 } }, pm, poly, SETTINGS, rec, new Map(), new Map(), undefined, sig); // under threshold, clears sig
    await hedgeOnce([PAIR], feed, { [PAIR.limitlessSlug]: { yes: 0, no: 2.45 } }, pm, poly, SETTINGS, rec, new Map(), new Map(), undefined, sig); // re-crosses → surfaces again

    expect(skips(rec)).toHaveLength(2);
  });
});
