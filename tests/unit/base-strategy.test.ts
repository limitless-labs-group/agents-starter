/**
 * BaseStrategy execution routing with a fake trading client: BUY → createOrder,
 * SELL → sellShares (the old base class sent SELL decisions as BUYs), taker
 * delay → awaitFill when enabled, SKIP → nothing.
 */
import { describe, it, expect, vi } from 'vitest';
import { BaseStrategy, type StrategyDeps, type TradeDecision } from '../../src/strategies/base-strategy.js';

function fakeDeps(dryRun = false, settlementStatus = 'MINED') {
  const response = {
    order: { id: 'o1' },
    execution: {
      settlementStatus,
      eligibleAt: settlementStatus === 'DELAYED' ? '2026-01-01T00:00:00.000Z' : undefined,
      totalsRaw: { contractsGross: '0', contractsFee: '0', contractsNet: '0', usdGross: '0', usdFee: '0', usdNet: '0' },
    },
  };
  const trading = {
    isDryRun: () => dryRun,
    createOrder: vi.fn().mockResolvedValue(response),
    sellShares: vi.fn().mockResolvedValue(response),
    awaitFill: vi.fn().mockResolvedValue({ state: 'filled', contracts: 1, usd: 0.5, avgPrice: 0.5 }),
  };
  return { deps: { limitless: {}, trading } as unknown as StrategyDeps, trading };
}

class Probe extends BaseStrategy {
  decisions: TradeDecision[] = [];
  constructor(deps: StrategyDeps, awaitFills = false) {
    super({ id: 'p', type: 'probe', enabled: true }, deps);
    this.awaitFills = awaitFills;
  }
  async initialize() {}
  async tick() {
    return this.decisions;
  }
  async shutdown() {}
  getStats() {
    return { activePositions: 0, totalVolumeUsd: 0, pnlUsd: 0, lastTickDurationMs: 0 };
  }
  run(decisions: TradeDecision[]) {
    return this.executeDecisions(decisions);
  }
}

describe('BaseStrategy.executeDecisions', () => {
  it('routes BUY to createOrder with FOK by default', async () => {
    const { deps, trading } = fakeDeps();
    await new Probe(deps).run([{ action: 'BUY', marketSlug: 'm', side: 'YES', amountUsd: 2, priceLimit: 55, reason: 'r' }]);
    expect(trading.createOrder).toHaveBeenCalledWith({
      marketSlug: 'm',
      side: 'YES',
      limitPriceCents: 55,
      usdAmount: 2,
      orderType: 'FOK',
      postOnly: undefined,
    });
    expect(trading.sellShares).not.toHaveBeenCalled();
  });

  it('routes SELL to sellShares with explicit shares, FAK by default', async () => {
    const { deps, trading } = fakeDeps();
    await new Probe(deps).run([{ action: 'SELL', marketSlug: 'm', side: 'NO', amountUsd: 0, shares: 12.5, priceLimit: 40, reason: 'r' }]);
    expect(trading.sellShares).toHaveBeenCalledWith({
      marketSlug: 'm',
      side: 'NO',
      shares: 12.5,
      limitPriceCents: 40,
      orderType: 'FAK',
      postOnly: undefined,
    });
    expect(trading.createOrder).not.toHaveBeenCalled();
  });

  it('derives SELL shares from amountUsd / price when shares is absent', async () => {
    const { deps, trading } = fakeDeps();
    await new Probe(deps).run([{ action: 'SELL', marketSlug: 'm', side: 'YES', amountUsd: 5, priceLimit: 50, reason: 'r' }]);
    expect(trading.sellShares.mock.calls[0][0].shares).toBeCloseTo(10);
  });

  it('never sends a FOK sell (downgrades to FAK)', async () => {
    const { deps, trading } = fakeDeps();
    await new Probe(deps).run([{ action: 'SELL', marketSlug: 'm', side: 'YES', shares: 1, amountUsd: 0, priceLimit: 50, orderType: 'FOK', reason: 'r' }]);
    expect(trading.sellShares.mock.calls[0][0].orderType).toBe('FAK');
  });

  it('skips SKIP decisions and keeps going after a failure', async () => {
    const { deps, trading } = fakeDeps();
    trading.createOrder.mockRejectedValueOnce(new Error('boom'));
    await new Probe(deps).run([
      { action: 'SKIP', marketSlug: 'a', side: 'YES', amountUsd: 1, priceLimit: 50, reason: 'r' },
      { action: 'BUY', marketSlug: 'b', side: 'YES', amountUsd: 1, priceLimit: 50, reason: 'r' },
      { action: 'BUY', marketSlug: 'c', side: 'YES', amountUsd: 1, priceLimit: 50, reason: 'r' },
    ]);
    expect(trading.createOrder).toHaveBeenCalledTimes(2);
  });

  it('waits for a DELAYED taker order only when awaitFills is on', async () => {
    const delayed = fakeDeps(false, 'DELAYED');
    await new Probe(delayed.deps, true).run([{ action: 'BUY', marketSlug: 'm', side: 'YES', amountUsd: 1, priceLimit: 50, reason: 'r' }]);
    expect(delayed.trading.awaitFill).toHaveBeenCalledWith('o1', 'FOK', { eligibleAt: '2026-01-01T00:00:00.000Z' });

    const fireAndForget = fakeDeps(false, 'DELAYED');
    await new Probe(fireAndForget.deps, false).run([{ action: 'BUY', marketSlug: 'm', side: 'YES', amountUsd: 1, priceLimit: 50, reason: 'r' }]);
    expect(fireAndForget.trading.awaitFill).not.toHaveBeenCalled();
  });

  it('does not inspect execution in dry run', async () => {
    const { deps, trading } = fakeDeps(true, 'DELAYED');
    await new Probe(deps, true).run([{ action: 'BUY', marketSlug: 'm', side: 'YES', amountUsd: 1, priceLimit: 50, reason: 'r' }]);
    expect(trading.awaitFill).not.toHaveBeenCalled();
  });
});
