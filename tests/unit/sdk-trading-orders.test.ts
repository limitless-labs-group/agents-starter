/**
 * SDKTradingClient order paths over a fake SDK: BUY/SELL argument mapping,
 * cancel-replace wiring, status/batch requests, and awaitFill's taker-delay
 * polling. No network.
 */
import { describe, it, expect, vi } from 'vitest';
import { CancelReplaceMode, OrderType, Side, type Client } from '@limitless-exchange/sdk';
import { SDKTradingClient } from '../../src/core/limitless/sdk-trading.js';

const KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const HMAC = { tokenId: 'tok', secret: 'c2VjcmV0' };

function fakeSdk() {
  const orderClient = {
    ownerId: undefined,
    createOrder: vi.fn().mockResolvedValue({ order: { id: 'new' }, execution: { settlementStatus: 'MINED', totalsRaw: {} } }),
    cancelReplace: vi.fn().mockResolvedValue({ cancel: { status: 'SUCCESS', orderId: 'old' }, replacement: { status: 'SUCCESS', data: { order: { id: 'new' } } } }),
    cancel: vi.fn().mockResolvedValue({ message: 'ok' }),
    cancelAll: vi.fn().mockResolvedValue({ message: 'ok' }),
  };
  const sdk = {
    markets: { getMarket: vi.fn().mockResolvedValue({ slug: 'm', tokens: { yes: 'YES_ID', no: 'NO_ID' } }) },
    portfolio: { getCLOBPositions: vi.fn().mockResolvedValue([]) },
    http: { post: vi.fn() },
    newOrderClient: () => orderClient,
  } as unknown as Client;
  return { sdk, orderClient, http: (sdk as unknown as { http: { post: ReturnType<typeof vi.fn> } }).http };
}

describe('SDKTradingClient order argument mapping', () => {
  it('FOK BUY passes USD notional as makerAmount for the resolved token', async () => {
    const { sdk, orderClient } = fakeSdk();
    const c = new SDKTradingClient({ privateKey: KEY, hmacCredentials: HMAC, sdk, dryRun: false });
    await c.createOrder({ marketSlug: 'm', side: 'NO', limitPriceCents: 40, usdAmount: 3 });
    expect(orderClient.createOrder).toHaveBeenCalledWith({
      tokenId: 'NO_ID',
      side: Side.BUY,
      orderType: OrderType.FOK,
      makerAmount: 3,
      marketSlug: 'm',
    });
  });

  it('GTC BUY converts USD to shares on the 0.001 grid and forwards postOnly', async () => {
    const { sdk, orderClient } = fakeSdk();
    const c = new SDKTradingClient({ privateKey: KEY, hmacCredentials: HMAC, sdk, dryRun: false });
    await c.createOrder({ marketSlug: 'm', side: 'YES', limitPriceCents: 33, usdAmount: 2, orderType: 'GTC', postOnly: true });
    const args = orderClient.createOrder.mock.calls[0][0];
    expect(args.side).toBe(Side.BUY);
    expect(args.orderType).toBe(OrderType.GTC);
    expect(args.price).toBeCloseTo(0.33);
    expect(args.size).toBeCloseTo(6.061, 3);
    expect(args.postOnly).toBe(true);
  });

  it('sellShares floors the size and sends Side.SELL as FAK', async () => {
    const { sdk, orderClient } = fakeSdk();
    const c = new SDKTradingClient({ privateKey: KEY, hmacCredentials: HMAC, sdk, dryRun: false });
    await c.sellShares({ marketSlug: 'm', side: 'YES', shares: 4.99999, limitPriceCents: 60 });
    const args = orderClient.createOrder.mock.calls[0][0];
    expect(args.side).toBe(Side.SELL);
    expect(args.orderType).toBe(OrderType.FAK);
    expect(args.size).toBeCloseTo(4.999, 3);
    expect(args.tokenId).toBe('YES_ID');
  });

  it('cancelReplace targets by orderId and builds the replacement from cents + shares', async () => {
    const { sdk, orderClient } = fakeSdk();
    const c = new SDKTradingClient({ privateKey: KEY, hmacCredentials: HMAC, sdk, dryRun: false });
    const res = await c.cancelReplace({ orderId: 'old', marketSlug: 'm', side: 'YES', limitPriceCents: 45, shares: 10, postOnly: true });
    expect(res.replacement.status).toBe('SUCCESS');
    expect(orderClient.cancelReplace).toHaveBeenCalledWith({
      cancel: { orderId: 'old' },
      replacement: { tokenId: 'YES_ID', price: 0.45, size: 10, side: Side.BUY, orderType: OrderType.GTC, marketSlug: 'm', postOnly: true },
      mode: CancelReplaceMode.STOP_ON_FAILURE,
    });
  });

  it('cancelReplace requires an identifier', async () => {
    const { sdk } = fakeSdk();
    const c = new SDKTradingClient({ privateKey: KEY, hmacCredentials: HMAC, sdk, dryRun: false });
    await expect(c.cancelReplace({ marketSlug: 'm', side: 'YES', limitPriceCents: 45, shares: 1 })).rejects.toThrow(/orderId or clientOrderId/);
  });
});

describe('order status + awaitFill', () => {
  it('getOrderStatuses posts items to /orders/status/batch and caps at 50', async () => {
    const { sdk, http } = fakeSdk();
    http.post.mockResolvedValue({ results: [{ index: 0, status: 'found', orderId: 'a', data: { execution: { settlementStatus: 'MINED' } } }] });
    const c = new SDKTradingClient({ privateKey: KEY, hmacCredentials: HMAC, sdk, dryRun: false });
    const res = await c.getOrderStatuses([{ orderId: 'a' }]);
    expect(http.post).toHaveBeenCalledWith('/orders/status/batch', { items: [{ orderId: 'a' }] });
    expect(res[0].status).toBe('found');
    await expect(c.getOrderStatuses(new Array(51).fill({ orderId: 'x' }))).rejects.toThrow(/50/);
  });

  it('awaitFill polls until a terminal state, honoring eligibleAt', async () => {
    const { sdk, http } = fakeSdk();
    http.post
      .mockResolvedValueOnce({ results: [{ index: 0, status: 'found', orderId: 'a', data: { execution: { settlementStatus: 'DELAYED', totalsRaw: {} } } }] })
      .mockResolvedValueOnce({ results: [{ index: 0, status: 'found', orderId: 'a', data: { execution: { settlementStatus: 'MATCHED', totalsRaw: {} } } }] })
      .mockResolvedValueOnce({
        results: [{ index: 0, status: 'found', orderId: 'a', data: { execution: { settlementStatus: 'MINED', txHash: '0x1', totalsRaw: { contractsGross: '2000000', contractsNet: '2000000', usdGross: '1000000', usdNet: '1000000', contractsFee: '0', usdFee: '0' } } } }],
      });
    const c = new SDKTradingClient({ privateKey: KEY, hmacCredentials: HMAC, sdk, dryRun: false });
    const started = Date.now();
    const summary = await c.awaitFill('a', 'FOK', { pollMs: 5, timeoutMs: 2_000, eligibleAt: new Date(Date.now() + 30).toISOString() });
    expect(Date.now() - started).toBeGreaterThanOrEqual(25);
    expect(http.post).toHaveBeenCalledTimes(3);
    expect(summary.state).toBe('filled');
    expect(summary.avgPrice).toBeCloseTo(0.5);
    expect(summary.txHash).toBe('0x1');
  });

  it('awaitFill returns resting for a GTC that has not crossed', async () => {
    const { sdk, http } = fakeSdk();
    http.post.mockResolvedValue({ results: [{ index: 0, status: 'found', orderId: 'g', data: { execution: { settlementStatus: 'UNMATCHED', totalsRaw: {} } } }] });
    const c = new SDKTradingClient({ privateKey: KEY, hmacCredentials: HMAC, sdk, dryRun: false });
    expect((await c.awaitFill('g', 'GTC', { pollMs: 1 })).state).toBe('resting');
  });

  it('awaitFill gives up with the last state on timeout', async () => {
    const { sdk, http } = fakeSdk();
    http.post.mockResolvedValue({ results: [{ index: 0, status: 'found', orderId: 'a', data: { execution: { settlementStatus: 'DELAYED', totalsRaw: {} } } }] });
    const c = new SDKTradingClient({ privateKey: KEY, hmacCredentials: HMAC, sdk, dryRun: false });
    expect((await c.awaitFill('a', 'FOK', { pollMs: 1, timeoutMs: 20 })).state).toBe('pending');
  });

  it('dry run never touches the network for status or fills', async () => {
    const { sdk, http } = fakeSdk();
    const c = new SDKTradingClient({ privateKey: KEY, hmacCredentials: HMAC, sdk, dryRun: true });
    expect((await c.getOrderStatuses([{ orderId: 'a' }]))[0].status).toBe('not_found');
    expect((await c.awaitFill('a', 'FOK')).state).toBe('unknown');
    expect(http.post).not.toHaveBeenCalled();
  });
});
