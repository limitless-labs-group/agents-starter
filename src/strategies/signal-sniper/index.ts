import { BaseStrategy, StrategyConfig, TradeDecision } from '../base-strategy.js';
import { LimitlessClient } from '../../core/limitless/markets.js';
import { TradingClient } from '../../core/limitless/trading.js';
import { CoinGeckoClient } from '../../core/price-feeds/coingecko.js';
import { recordTrade, getLearnings, suggestAdjustments } from './learnings.js';

interface SignalSniperConfig extends StrategyConfig {
    sources: {
        type: 'coingecko';
        assets: string[]; // e.g. ['dogecoin']
        pollIntervalMs: number;
    }[];
    minConfidence: number;      // Min probability edge (e.g. 0.1 = 10%)
    maxPositionUsd: number;     // Max per trade
    edgeThresholdPercent: number; // How much mispricing to act on
}

// Map CoinGecko IDs to Limitless search terms
const ASSET_TICKERS: Record<string, string> = {
    'dogecoin': 'DOGE',
    'bitcoin': 'BTC',
    'ethereum': 'ETH',
    'solana': 'SOL',
};

export class SignalSniperStrategy extends BaseStrategy {
    private coingecko: CoinGeckoClient;
    private tradedMarkets: Set<string> = new Set(); // Avoid double-trading same market

    constructor(
        config: StrategyConfig,
        deps: { limitless: LimitlessClient; trading: TradingClient }
    ) {
        super(config, deps);
        this.coingecko = new CoinGeckoClient();
        this.tickIntervalMs = 15000; // Check every 15s for fast-moving markets
    }

    async initialize(): Promise<void> {
        this.logger.info('Initializing Signal Sniper');
        
        // Log current learnings
        const stats = getLearnings();
            
        if (stats.totalTrades > 0) {
            this.logger.info({ 
                trades: stats.totalTrades, 
                winRate: (stats.winRate * 100).toFixed(1) + '%',
                pending: stats.pending 
            }, 'Loaded trade history');
            
            const suggestions = suggestAdjustments();
            if (suggestions.length) {
                this.logger.info({ suggestions }, 'Strategy suggestions based on history');
            }
        }
    }

    async tick(): Promise<TradeDecision[]> {
        const decisions: TradeDecision[] = [];
        const config = this.config as SignalSniperConfig;

        for (const source of config.sources) {
            if (source.type === 'coingecko') {
                for (const asset of source.assets) {
                    try {
                        const currentPrice = await this.coingecko.getPrice(asset);
                        if (currentPrice <= 0) continue;

                        const ticker = ASSET_TICKERS[asset] || asset.toUpperCase();
                        this.logger.info({ asset, ticker, currentPrice }, 'Checking price');

                        // Search for markets with this ticker
                        const markets = await this.limitless.searchMarkets(ticker, { limit: 20 });

                        for (const market of markets) {
                            // Skip already traded markets
                            if (this.tradedMarkets.has(market.slug)) continue;

                            // Skip AMM markets (no CLOB)
                            if (market.tradeType !== 'clob') continue;

                            // Parse strike price from market title
                            const strike = this.parseStrikePrice(market);
                            if (!strike) continue;

                            // Check if market expires soon (within 2 hours)
                            const expiresAt = market.expirationTimestamp;
                            const now = Date.now();
                            const hoursToExpiry = (expiresAt - now) / (1000 * 60 * 60);
                            
                            if (hoursToExpiry < 0 || hoursToExpiry > 2) continue;

                            // Get current market prices
                            const yesPrice = market.prices?.[0] || 0.5;
                            const noPrice = market.prices?.[1] || 0.5;

                            // Calculate fair value based on current price vs strike
                            const percentFromStrike = (currentPrice - strike) / strike;
                            const absPercent = Math.abs(percentFromStrike);
                            const confidence = Math.min(0.95, 0.50 + absPercent * 40);
                            
                            let fairYes: number;
                            if (currentPrice > strike) {
                                fairYes = confidence; // above strike → YES more likely
                            } else {
                                fairYes = 1 - confidence; // below strike → NO more likely
                            }
                            
                            fairYes = Math.max(0.02, Math.min(0.98, fairYes));

                            // Calculate edge
                            const yesEdge = fairYes - yesPrice;
                            const noEdge = (1 - fairYes) - noPrice;

                            const minEdge = config.edgeThresholdPercent / 100;

                            this.logger.info({
                                market: market.slug,
                                strike,
                                currentPrice,
                                yesPrice,
                                fairYes,
                                yesEdge: (yesEdge * 100).toFixed(1) + '%',
                                hoursToExpiry: hoursToExpiry.toFixed(2)
                            }, 'Evaluating market');

                            // BUY YES if underpriced
                            if (yesEdge > minEdge && yesPrice < 0.90) {
                                this.logger.info({ 
                                    action: 'BUY YES', 
                                    market: market.title,
                                    yesPrice, 
                                    fairYes,
                                    edge: yesEdge 
                                }, ' SIGNAL: BUY YES');

                                decisions.push({
                                    action: 'BUY',
                                    marketSlug: market.slug,
                                    side: 'YES',
                                    amountUsd: config.maxPositionUsd,
                                    priceLimit: Math.min(Math.floor((yesPrice + 0.05) * 100), 95),
                                    reason: `Signal: ${ticker} $${currentPrice.toFixed(4)} > $${strike} strike. YES fair=${fairYes}, market=${yesPrice}`
                                });
                                
                                recordTrade({
                                    market: market.slug,
                                    asset: ticker,
                                    strike,
                                    priceAtEntry: currentPrice,
                                    side: 'YES',
                                    betSize: config.maxPositionUsd,
                                    edgePercent: yesEdge * 100,
                                    hoursToExpiry
                                });
                                
                                this.tradedMarkets.add(market.slug);
                            }

                            // BUY NO if underpriced
                            if (noEdge > minEdge && noPrice < 0.90) {
                                this.logger.info({ 
                                    action: 'BUY NO', 
                                    market: market.title,
                                    noPrice, 
                                    fairNo: 1 - fairYes,
                                    edge: noEdge 
                                }, ' SIGNAL: BUY NO');

                                decisions.push({
                                    action: 'BUY',
                                    marketSlug: market.slug,
                                    side: 'NO',
                                    amountUsd: config.maxPositionUsd,
                                    priceLimit: Math.min(Math.floor((noPrice + 0.05) * 100), 95),
                                    reason: `Signal: ${ticker} $${currentPrice.toFixed(4)} < $${strike} strike. NO fair=${1-fairYes}, market=${noPrice}`
                                });
                                
                                recordTrade({
                                    market: market.slug,
                                    asset: ticker,
                                    strike,
                                    priceAtEntry: currentPrice,
                                    side: 'NO',
                                    betSize: config.maxPositionUsd,
                                    edgePercent: noEdge * 100,
                                    hoursToExpiry
                                });
                                
                                this.tradedMarkets.add(market.slug);
                            }
                        }
                    } catch (e: any) {
                        this.logger.error({ asset, err: e?.message }, 'Error processing asset');
                    }
                }
            }
        }

        return decisions;
    }

    private parseStrikePrice(market: any): number | null {
        // Try metadata first
        if (market.metadata?.openPrice) {
            return parseFloat(market.metadata.openPrice);
        }

        // Parse from title: "$DOGE above $0.09712 on Feb 13"
        const match = market.title?.match(/\$?([\d.]+)\s+on/i);
        if (match) {
            return parseFloat(match[1]);
        }

        // Try another pattern: "above $X.XX"
        const match2 = market.title?.match(/above\s+\$?([\d.]+)/i);
        if (match2) {
            return parseFloat(match2[1]);
        }

        return null;
    }

    async shutdown(): Promise<void> {
        this.logger.info({ tradedMarkets: Array.from(this.tradedMarkets) }, 'Signal Sniper shutting down');
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
