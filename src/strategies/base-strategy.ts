/**
 * BaseStrategy — the tick → decide → execute loop every strategy in this repo
 * runs on (except `cross-market-mm`, which has its own runtime).
 *
 * Subclasses implement `initialize()`, `tick()`, `shutdown()`, `getStats()`.
 * `tick()` returns `TradeDecision[]`; the base class executes them through
 * `SDKTradingClient`, which honors `DRY_RUN` (log intents, sign nothing).
 *
 * Execution semantics:
 *   - BUY  → `trading.createOrder` (FOK by default; GTC/FAK via `orderType`).
 *   - SELL → `trading.sellShares` (FAK by default). Needs `shares`; falls back
 *            to `amountUsd / price` when only a notional was given.
 *   - Taker delay: FOK/FAK on a market with `settings.takerDelayMs > 0` come
 *     back `DELAYED` with an `eligibleAt`. That is not an error; when
 *     `awaitFills` is on, the loop waits for the terminal state before moving on.
 */

import type { LimitlessClient } from '../core/limitless/markets.js';
import type { SDKTradingClient } from '../core/limitless/sdk-trading.js';
import { summarizeExecution } from '../core/limitless/execution.js';
import type { OrderType, OutcomeSide } from '../core/limitless/types.js';
import { pino, type Logger } from 'pino';

export interface StrategyConfig {
  id: string;
  type: string;
  enabled: boolean;
  maxPositionUsd?: number;
  [key: string]: unknown;
}

export interface TradeDecision {
  action: 'BUY' | 'SELL' | 'SKIP';
  marketSlug: string;
  side: OutcomeSide;
  /** BUY: USD notional to spend. SELL: used only when `shares` is absent. */
  amountUsd: number;
  /** Limit price in cents (1..99). */
  priceLimit: number;
  reason: string;
  /** SELL: number of shares to sell. */
  shares?: number;
  /** GTC (resting), FOK (fill-or-kill), FAK (fill-and-kill). Default: BUY → FOK, SELL → FAK. */
  orderType?: OrderType;
  /** GTC only: reject instead of crossing the book. */
  postOnly?: boolean;
  /** Optional signal confidence, for logging/sizing. */
  confidence?: number;
  /** Optional price ladder (cents) a strategy may split the order across. */
  ladder?: number[];
}

export interface StrategyStats {
  activePositions: number;
  totalVolumeUsd: number;
  pnlUsd: number;
  lastTickDurationMs: number;
}

export interface StrategyDeps {
  limitless: LimitlessClient;
  trading: SDKTradingClient;
}

export abstract class BaseStrategy {
  protected logger: Logger;
  protected running = false;
  protected tickIntervalMs = 60_000;
  protected tickTimer: NodeJS.Timeout | null = null;
  /** When true, taker orders block until a terminal state (honoring taker delay). */
  protected awaitFills = false;
  protected lastTickDurationMs = 0;

  protected limitless: LimitlessClient;
  protected trading: SDKTradingClient;

  constructor(
    protected config: StrategyConfig,
    deps: StrategyDeps,
  ) {
    this.limitless = deps.limitless;
    this.trading = deps.trading;
    this.logger = pino({
      level: process.env.LOG_LEVEL || 'info',
      name: `strategy:${config.type}:${config.id}`,
    });
  }

  abstract initialize(): Promise<void>;
  abstract tick(): Promise<TradeDecision[]>;
  abstract shutdown(): Promise<void>;
  abstract getStats(): StrategyStats;

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.logger.info({ dryRun: this.trading.isDryRun() }, 'Starting strategy');
    await this.initialize();
    void this.runTick();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.tickTimer) {
      clearTimeout(this.tickTimer);
      this.tickTimer = null;
    }
    await this.shutdown();
    this.logger.info('Strategy stopped');
  }

  private async runTick(): Promise<void> {
    if (!this.running) return;
    const start = Date.now();
    try {
      const decisions = await this.tick();
      await this.executeDecisions(decisions);
    } catch (error) {
      this.logger.error({ err: (error as Error)?.message ?? error }, 'Error in strategy tick');
    }
    this.lastTickDurationMs = Date.now() - start;
    // Never spin: if a tick overran its interval, wait at least 1s.
    const nextTick = Math.max(1000, this.tickIntervalMs - this.lastTickDurationMs);
    if (this.running) {
      this.tickTimer = setTimeout(() => void this.runTick(), nextTick);
    }
  }

  protected async executeDecisions(decisions: TradeDecision[]): Promise<void> {
    for (const decision of decisions) {
      if (decision.action === 'SKIP') continue;
      try {
        this.logger.info({ decision }, 'Executing trade decision');
        const orderType = decision.orderType ?? (decision.action === 'BUY' ? 'FOK' : 'FAK');

        const res =
          decision.action === 'BUY'
            ? await this.trading.createOrder({
                marketSlug: decision.marketSlug,
                side: decision.side,
                limitPriceCents: decision.priceLimit,
                usdAmount: decision.amountUsd,
                orderType,
                postOnly: decision.postOnly,
              })
            : await this.trading.sellShares({
                marketSlug: decision.marketSlug,
                side: decision.side,
                shares: decision.shares ?? decision.amountUsd / (decision.priceLimit / 100),
                limitPriceCents: decision.priceLimit,
                orderType: orderType === 'FOK' ? 'FAK' : orderType,
                postOnly: decision.postOnly,
              });

        if (this.trading.isDryRun()) continue;

        let summary = summarizeExecution(res, orderType);
        if (summary.state === 'pending' && this.awaitFills && res.order?.id) {
          this.logger.info(
            { orderId: res.order.id, eligibleAt: summary.eligibleAt },
            'Order pending (taker delay or settling) — waiting for terminal state',
          );
          summary = await this.trading.awaitFill(res.order.id, orderType, { eligibleAt: summary.eligibleAt });
        }
        this.logger.info(
          {
            orderId: res.order?.id,
            state: summary.state,
            settlementStatus: summary.settlementStatus,
            contracts: summary.contracts,
            usd: summary.usd,
            avgPrice: summary.avgPrice,
            txHash: summary.txHash,
          },
          'Order result',
        );
      } catch (error) {
        this.logger.error({ err: (error as Error)?.message ?? error, decision }, 'Failed to execute decision');
      }
    }
  }
}
