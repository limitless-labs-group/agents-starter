/**
 * Polymarket CLOB constraints + Data API v2 position rows.
 *
 * The CLOB publishes `min_order_size` on every `GET /book` and rejects orders
 * below it ("Size lower than the minimum"). The old hard-coded $1 notional
 * floor was never the rule; the floor is per-market and read live.
 * Positions come from Data API v2 (`data`-wrapped rows with `token_id` +
 * `current_size`), not the frozen v1 `asset` / `size` shape.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MIN_ORDER_SIZE,
  parseMinOrderSize,
  positionsFromRows,
} from '../../src/core/polymarket/client.js';

describe('parseMinOrderSize', () => {
  it('reads min_order_size from a CLOB book payload', () => {
    expect(
      parseMinOrderSize({
        asset_id: 'x',
        bids: [],
        asks: [],
        min_order_size: '5',
        tick_size: '0.01',
        neg_risk: false,
      }),
    ).toBe(5);
    expect(parseMinOrderSize({ min_order_size: '15' })).toBe(15);
  });

  it('returns null on missing or junk values so the caller can fall back', () => {
    expect(parseMinOrderSize({})).toBeNull();
    expect(parseMinOrderSize({ min_order_size: 'abc' })).toBeNull();
    expect(parseMinOrderSize({ min_order_size: '0' })).toBeNull();
    expect(parseMinOrderSize(null)).toBeNull();
    expect(parseMinOrderSize('5')).toBeNull();
  });

  it('fallback matches the floor every observed book publishes', () => {
    expect(DEFAULT_MIN_ORDER_SIZE).toBe(5);
  });
});

describe('positionsFromRows (Data API v2)', () => {
  const pairs = [
    { polymarketSlug: 'poly-a', limitlessSlug: 'lmts-a', polyYesAssetId: 'A_YES', polyNoAssetId: 'A_NO' },
    { polymarketSlug: 'poly-b', limitlessSlug: 'lmts-b', polyYesAssetId: 'B_YES', polyNoAssetId: 'B_NO' },
  ];

  it('maps token_id + current_size onto the configured pairs', () => {
    const out = positionsFromRows(
      [
        { token_id: 'A_YES', current_size: 12.5 },
        { token_id: 'A_NO', current_size: '3' },
        { token_id: 'B_NO', current_size: 7 },
        { token_id: 'UNRELATED', current_size: 99 },
      ],
      pairs,
    );
    expect(out.get('poly-a')).toEqual({ yes: 12.5, no: 3 });
    expect(out.get('poly-b')).toEqual({ yes: 0, no: 7 });
    expect(out.size).toBe(2);
  });

  it('ignores the v1 asset/size shape instead of mis-reading it', () => {
    const out = positionsFromRows([{ asset: 'A_YES', size: 12.5 } as never], pairs);
    expect(out.size).toBe(0);
  });

  it('skips non-numeric sizes', () => {
    const out = positionsFromRows([{ token_id: 'A_YES', current_size: 'nan?' }], pairs);
    expect(out.size).toBe(0);
  });
});
