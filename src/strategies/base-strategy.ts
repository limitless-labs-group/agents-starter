import { LimitlessClient } from '../core/limitless/markets.js';
import { TradingClient } from '../core/limitless/trading.js';
import { pino, Logger } from 'pino';

export interface StrategyConfig {
    id: string;
    type: string;
    enabled: boolean;
    maxPositionUsd?: number;
    [key: string]: any;
}

export interface TradeDecision {
    action: 'BUY' | 'SELL' | 'SKIP';
    marketSlug: string;
    side: 'YES' | 'NO';
    amountUsd: number;
    priceLimit: number;
    reason: string;
}

export interface StrategyStats {
    activePositions: number;
    totalVolumeUsd: number;
    pnlUsd: number;
    lastTickDurationMs: number;
}

export abstract class BaseStrategy {
    protected logger: Logger;
    protected running: boolean = false;
    protected tickIntervalMs: number = 60000;
    protected tickTimer: NodeJS.Timeout | null = null;

    // Shared services
    protected limitless: LimitlessClient;
    protected trading: TradingClient;

    constructor(
        protected config: StrategyConfig,
        dependencies: {
            limitless: LimitlessClient;
            trading: TradingClient;
        }
    ) {
        this.limitless = dependencies.limitless;
        this.trading = dependencies.trading;
        this.logger = pino({
            level: process.env.LOG_LEVEL || 'info',
            name: `strategy:${config.type}:${config.id}`
        });
    }

    abstract initialize(): Promise<void>;
    abstract tick(): Promise<TradeDecision[]>;
    abstract shutdown(): Promise<void>;

    async start(): Promise<void> {
        if (this.running) return;
        this.running = true;
        this.logger.info('Starting strategy');

        await this.initialize();

        this.runTick();
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

    private async runTick() {
        if (!this.running) return;

        const start = Date.now();
        try {
            const decisions = await this.tick();
            await this.executeDecisions(decisions);
        } catch (error: any) {
            this.logger.error({ err: error?.message || error }, 'Error in strategy tick');
        }

        const duration = Date.now() - start;
        const nextTick = Math.max(1000, this.tickIntervalMs - duration); // prevent spam if tick takes too long

        if (this.running) {
            this.tickTimer = setTimeout(() => this.runTick(), nextTick);
        }
    }

    protected async executeDecisions(decisions: TradeDecision[]) {
        for (const decision of decisions) {
            if (decision.action === 'SKIP') continue;

            try {
                this.logger.info({ decision }, 'Executing trade decision');

                if (decision.action === 'BUY') { // Or SELL if implemented
                    await this.trading.createOrder({
                        marketSlug: decision.marketSlug,
                        side: decision.side,
                        limitPriceCents: decision.priceLimit,
                        usdAmount: decision.amountUsd
                    });
                }
            } catch (error: any) {
                this.logger.error({ err: error?.message || error, decision }, 'Failed to execute decision');
            }
        }
    }

    abstract getStats(): StrategyStats;
}
