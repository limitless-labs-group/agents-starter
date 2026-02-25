/**
 * Binary Complement Arb Scanner
 * 
 * Finds markets where YES + NO prices sum to less than $1.00.
 * In a binary market, YES + NO should always equal $1. When they don't,
 * buying both sides guarantees profit at resolution.
 * 
 * Example: YES = $0.45, NO = $0.48 → Total = $0.93
 * Buy both for $0.93, guaranteed $1.00 at resolution → $0.07 profit (7.5% return)
 */

import { BaseStrategy, StrategyConfig, TradeDecision } from '../base-strategy.js';
import { LimitlessClient } from '../../core/limitless/markets.js';
import { TradingClient } from '../../core/limitless/trading.js';
import { pino } from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL || 'info', name: 'complement-arb' });

interface ComplementArbConfig extends StrategyConfig {
    minSpreadPercent: number;  // Minimum profit margin (e.g. 3 = 3%)
    maxPositionUsd: number;    // Max per arb trade
    scanIntervalMs: number;    // How often to scan
}

export interface ArbOpportunity {
    marketSlug: string;
    marketTitle: string;
    yesPrice: number;
    noPrice: number;
    totalCost: number;        // YES + NO price (should be < 1.0 for arb)
    profitPercent: number;    // (1 - totalCost) / totalCost * 100
    guaranteedProfit: number; // Per $1 invested
}

export class ComplementArbStrategy extends BaseStrategy {
    private tradedMarkets: Set<string> = new Set();

    constructor(
        config: StrategyConfig,
        deps: { limitless: LimitlessClient; trading: TradingClient }
    ) {
        super(config, deps);
        this.tickIntervalMs = (config as ComplementArbConfig).scanIntervalMs || 30000;
    }

    async initialize(): Promise<void> {
        this.logger.info('Initializing Binary Complement Arb Scanner');
    }

    async tick(): Promise<TradeDecision[]> {
        const decisions: TradeDecision[] = [];
        const config = this.config as ComplementArbConfig;
        const minSpread = config.minSpreadPercent / 100;

        try {
            // Scan all active CLOB markets
            const markets = await this.limitless.getActiveMarkets({ tradeType: 'clob', limit: 100 });

            for (const market of markets) {
                if (this.tradedMarkets.has(market.slug)) continue;
                if (!market.prices || market.prices.length < 2) continue;

                const yesPrice = market.prices[0];
                const noPrice = market.prices[1];
                
                // Skip if prices look invalid
                if (yesPrice <= 0 || noPrice <= 0) continue;
                if (yesPrice >= 1 || noPrice >= 1) continue;

                const totalCost = yesPrice + noPrice;
                
                // Arb exists when total < 1.0
                if (totalCost >= 1.0) continue;

                const profitPercent = ((1.0 - totalCost) / totalCost) * 100;
                
                if (profitPercent < config.minSpreadPercent) continue;

                const opp: ArbOpportunity = {
                    marketSlug: market.slug,
                    marketTitle: market.title,
                    yesPrice,
                    noPrice,
                    totalCost,
                    profitPercent,
                    guaranteedProfit: 1.0 - totalCost,
                };

                this.logger.info({
                    market: market.title,
                    yes: yesPrice.toFixed(3),
                    no: noPrice.toFixed(3),
                    total: totalCost.toFixed(3),
                    profit: profitPercent.toFixed(1) + '%',
                }, ' COMPLEMENT ARB FOUND');

                // Buy both sides
                const betPerSide = config.maxPositionUsd / 2;

                decisions.push({
                    action: 'BUY',
                    marketSlug: market.slug,
                    side: 'YES',
                    amountUsd: betPerSide,
                    priceLimit: Math.floor((yesPrice + 0.02) * 100), // Slight buffer
                    reason: `Complement arb: YES=${yesPrice} + NO=${noPrice} = ${totalCost.toFixed(3)} < $1. Profit: ${profitPercent.toFixed(1)}%`
                });

                decisions.push({
                    action: 'BUY',
                    marketSlug: market.slug,
                    side: 'NO',
                    amountUsd: betPerSide,
                    priceLimit: Math.floor((noPrice + 0.02) * 100),
                    reason: `Complement arb: YES=${yesPrice} + NO=${noPrice} = ${totalCost.toFixed(3)} < $1. Profit: ${profitPercent.toFixed(1)}%`
                });

                this.tradedMarkets.add(market.slug);
            }
        } catch (e: any) {
            this.logger.error({ err: e?.message }, 'Error scanning markets');
        }

        return decisions;
    }

    async shutdown(): Promise<void> {
        this.logger.info({ tradedMarkets: Array.from(this.tradedMarkets) }, 'Complement Arb shutting down');
    }

    getStats(): any {
        return {
            tradedMarkets: this.tradedMarkets.size,
            activePositions: 0,
            totalVolumeUsd: 0,
            pnlUsd: 0,
            lastTickDurationMs: 0,
        };
    }
}
