import { BaseStrategy, StrategyConfig, TradeDecision } from '../base-strategy.js';
import { LimitlessClient } from '../../core/limitless/markets.js';
import { TradingClient } from '../../core/limitless/trading.js';
import { HermesClient } from '../../core/price-feeds/hermes.js';
import { createPublicClient, http, parseAbi, formatUnits } from 'viem';
import { base } from 'viem/chains';
import fs from 'fs/promises';
import path from 'path';

const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as const;

export interface OracleArbConfig extends StrategyConfig {
    assets: string[]; // e.g., ['BTC', 'ETH', 'SOL']
    minConfidencePercent: number; // Min oracle confidence (0-1)
    minEdgePercent: number; // Min edge between oracle and market price (0-1)
    maxMarketPrice: number; // Max market price to pay (e.g., 0.70 for 70¢)
    betSizeUsd: number; // Per-trade size
    maxPositions: number; // Max concurrent positions
    minMinutesToExpiry: number; // Min time before market expires
    maxMinutesToExpiry: number; // Max time before market expires
}

interface PositionRecord {
    marketSlug: string;
    side: 'YES' | 'NO';
    entryPrice: number;
    oraclePriceAtEntry: number;
    oracleConfAtEntry: number;
    timestamp: number;
    amountUsd: number;
}

export class OracleArbStrategy extends BaseStrategy {
    private hermes: HermesClient;
    private tradedMarkets: Set<string> = new Set();
    private positions: Map<string, PositionRecord> = new Map();
    private readonly dataDir: string;
    private readonly positionsFile: string;
    private walletAddress: string = '';
    private portfolioBalance: number = 0;
    private lastBalanceCheck: number = 0;
    private tickCount: number = 0;

    constructor(
        config: StrategyConfig,
        deps: { limitless: LimitlessClient; trading: TradingClient }
    ) {
        super(config, deps);
        this.hermes = new HermesClient();
        this.tickIntervalMs = 10000; // Scan every 10s

        // Store positions persistently
        this.dataDir = process.env.DATA_DIR || './data';
        this.positionsFile = path.join(this.dataDir, 'oracle-arb-positions.json');
    }

    async initialize(): Promise<void> {
        this.logger.info('Initializing Oracle Arb Strategy');
        const config = this.config as OracleArbConfig;

        // Load persisted positions
        await this.loadPositions();

        // Note: walletAddress should be set via setWalletAddress() before start()
        // Check portfolio balance before starting
        await this.checkPortfolioBalance();

        // Connect to Hermes price feed
        await this.hermes.connect(config.assets);

        this.logger.info({
            assets: config.assets,
            minConfidence: config.minConfidencePercent,
            minEdge: config.minEdgePercent,
            maxPrice: config.maxMarketPrice,
            loadedPositions: this.positions.size,
            portfolioBalance: this.portfolioBalance,
        }, 'Oracle Arb initialized');
    }

    /**
     * Set the wallet address for balance checking
     * Must be called before start() if you want portfolio balance checks
     */
    setWalletAddress(address: string): void {
        this.walletAddress = address;
    }

    /**
     * Check wallet USDC balance on-chain
     * Returns available USDC balance for trading
     */
    private async checkPortfolioBalance(): Promise<number> {
        try {
            if (!this.walletAddress) {
                this.logger.warn('Cannot check balance: wallet address not set');
                return 0;
            }

            const publicClient = createPublicClient({
                chain: base,
                transport: http(),
            });

            const balance = await publicClient.readContract({
                address: USDC_ADDRESS,
                abi: parseAbi(['function balanceOf(address) view returns (uint256)']),
                functionName: 'balanceOf',
                args: [this.walletAddress as `0x${string}`],
            });

            this.portfolioBalance = parseFloat(formatUnits(balance, 6));
            this.lastBalanceCheck = Date.now();
            this.logger.info({ balance: this.portfolioBalance }, 'Wallet USDC balance');
        } catch (e: any) {
            this.logger.error({ err: e.message }, 'Error checking wallet balance');
        }
        return this.portfolioBalance;
    }

    async tick(): Promise<TradeDecision[]> {
        const decisions: TradeDecision[] = [];
        const config = this.config as OracleArbConfig;

        this.tickCount++;

        // Check portfolio balance periodically (every 60 seconds)
        if (Date.now() - this.lastBalanceCheck > 60000) {
            await this.checkPortfolioBalance();
        }

        // Skip trading if no portfolio balance
        if (this.portfolioBalance <= 0) {
            if (this.tickCount % 10 === 0) { // Log every 10 ticks to avoid spam
                this.logger.warn(
                    { balance: this.portfolioBalance },
                    'Portfolio balance is $0. Deposit USDC to Limitless to start trading. '
                    + 'Visit https://limitless.exchange to deposit.'
                );
            }
            return decisions;
        }

        // Don't exceed max positions
        if (this.positions.size >= config.maxPositions) {
            this.logger.debug({ positions: this.positions.size }, 'Max positions reached');
            return decisions;
        }

        for (const asset of config.assets) {
            try {
                const oracleData = this.hermes.getPrice(asset);
                if (!oracleData) {
                    this.logger.debug({ asset }, 'No oracle price available');
                    continue;
                }

                const { price: oraclePrice, conf: oracleConf } = oracleData;

                // Confidence check: price ± confidence should give us conviction
                const confidenceWidth = oracleConf / oraclePrice;
                if (confidenceWidth > 1 - config.minConfidencePercent) {
                    this.logger.debug({ asset, confidenceWidth }, 'Oracle confidence too low');
                    continue;
                }

                // Search for markets with this asset
                const markets = await this.limitless.searchMarkets(asset, { limit: 20 });

                for (const market of markets) {
                    // Skip if already traded
                    if (this.tradedMarkets.has(market.slug)) continue;

                    // Skip AMM markets (no CLOB)
                    if (market.tradeType !== 'clob') continue;

                    // Check expiry window
                    const expiresAt = market.expirationTimestamp;
                    const now = Date.now();
                    const minutesToExpiry = (expiresAt - now) / (1000 * 60);

                    if (minutesToExpiry < config.minMinutesToExpiry ||
                        minutesToExpiry > config.maxMinutesToExpiry) {
                        continue;
                    }

                    // Parse strike price
                    const strike = this.parseStrikePrice(market);
                    if (!strike) continue;

                    // Get market prices
                    const yesPrice = market.prices?.[0] ?? 0.5;
                    const noPrice = market.prices?.[1] ?? 0.5;

                    // Calculate oracle's probability assessment
                    const percentFromStrike = (oraclePrice - strike) / strike;
                    const oracleYesProb = percentFromStrike > 0
                        ? Math.min(0.95, 0.5 + Math.abs(percentFromStrike) * 40)
                        : Math.max(0.05, 0.5 - Math.abs(percentFromStrike) * 40);

                    // Calculate edge
                    const yesEdge = oracleYesProb - yesPrice;
                    const noEdge = (1 - oracleYesProb) - noPrice;

                    this.logger.debug({
                        market: market.slug,
                        asset,
                        oraclePrice,
                        strike,
                        yesPrice,
                        noPrice,
                        oracleYesProb,
                        yesEdge: (yesEdge * 100).toFixed(1) + '%',
                        noEdge: (noEdge * 100).toFixed(1) + '%',
                        minutesToExpiry: Math.round(minutesToExpiry),
                    }, 'Evaluating market');

                    // BUY YES if edge exists and market price is good
                    if (yesEdge > config.minEdgePercent &&
                        yesPrice <= config.maxMarketPrice &&
                        oracleYesProb > config.minConfidencePercent) {

                        this.logger.info({
                            action: 'BUY YES',
                            market: market.title,
                            oraclePrice,
                            strike,
                            yesPrice,
                            oracleYesProb: (oracleYesProb * 100).toFixed(1) + '%',
                            edge: (yesEdge * 100).toFixed(1) + '%',
                        }, '🎯 ORACLE EDGE: BUY YES');

                        // Fire FOK at aggressive price (5¢ above current to try to get filled)
                        const fokPrice = Math.min(Math.floor((yesPrice + 0.05) * 100), 95);

                        decisions.push({
                            action: 'BUY',
                            marketSlug: market.slug,
                            side: 'YES',
                            amountUsd: config.betSizeUsd,
                            priceLimit: fokPrice,
                            reason: `Oracle: ${asset} $${oraclePrice.toFixed(2)} > $${strike} strike (${(oracleYesProb * 100).toFixed(0)}% prob). Market YES at ${(yesPrice * 100).toFixed(0)}¢`,
                        });

                        // Track as pending position (will confirm on fill)
                        this.positions.set(market.slug, {
                            marketSlug: market.slug,
                            side: 'YES',
                            entryPrice: yesPrice,
                            oraclePriceAtEntry: oraclePrice,
                            oracleConfAtEntry: oracleConf,
                            timestamp: Date.now(),
                            amountUsd: config.betSizeUsd,
                        });

                        this.tradedMarkets.add(market.slug);
                        await this.savePositions();
                    }

                    // BUY NO if edge exists and market price is good
                    if (noEdge > config.minEdgePercent &&
                        noPrice <= config.maxMarketPrice &&
                        (1 - oracleYesProb) > config.minConfidencePercent) {

                        this.logger.info({
                            action: 'BUY NO',
                            market: market.title,
                            oraclePrice,
                            strike,
                            noPrice,
                            oracleNoProb: ((1 - oracleYesProb) * 100).toFixed(1) + '%',
                            edge: (noEdge * 100).toFixed(1) + '%',
                        }, '🎯 ORACLE EDGE: BUY NO');

                        const fokPrice = Math.min(Math.floor((noPrice + 0.05) * 100), 95);

                        decisions.push({
                            action: 'BUY',
                            marketSlug: market.slug,
                            side: 'NO',
                            amountUsd: config.betSizeUsd,
                            priceLimit: fokPrice,
                            reason: `Oracle: ${asset} $${oraclePrice.toFixed(2)} < $${strike} strike (${((1 - oracleYesProb) * 100).toFixed(0)}% prob). Market NO at ${(noPrice * 100).toFixed(0)}¢`,
                        });

                        this.positions.set(market.slug, {
                            marketSlug: market.slug,
                            side: 'NO',
                            entryPrice: noPrice,
                            oraclePriceAtEntry: oraclePrice,
                            oracleConfAtEntry: oracleConf,
                            timestamp: Date.now(),
                            amountUsd: config.betSizeUsd,
                        });

                        this.tradedMarkets.add(market.slug);
                        await this.savePositions();
                    }
                }
            } catch (e: any) {
                this.logger.error({ asset, err: e?.message }, 'Error processing asset');
            }
        }

        return decisions;
    }

    async shutdown(): Promise<void> {
        this.hermes.disconnect();
        await this.savePositions();
        this.logger.info({ positions: this.positions.size }, 'Oracle Arb shutting down');
    }

    getStats(): any {
        return {
            activePositions: this.positions.size,
            tradedMarkets: this.tradedMarkets.size,
            totalVolumeUsd: Array.from(this.positions.values()).reduce((sum, p) => sum + p.amountUsd, 0),
            pnlUsd: 0, // Would need resolution tracking
            lastTickDurationMs: 0,
        };
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

    private async loadPositions(): Promise<void> {
        try {
            const data = await fs.readFile(this.positionsFile, 'utf8');
            const parsed = JSON.parse(data);
            for (const [slug, pos] of Object.entries(parsed)) {
                this.positions.set(slug, pos as PositionRecord);
                this.tradedMarkets.add(slug);
            }
            this.logger.info({ count: this.positions.size }, 'Loaded positions');
        } catch (e) {
            this.logger.info('No persisted positions found');
        }
    }

    private async savePositions(): Promise<void> {
        try {
            await fs.mkdir(this.dataDir, { recursive: true });
            const obj: Record<string, PositionRecord> = {};
            for (const [slug, pos] of this.positions) {
                obj[slug] = pos;
            }
            await fs.writeFile(this.positionsFile, JSON.stringify(obj, null, 2));
        } catch (e: any) {
            this.logger.error({ err: e?.message }, 'Failed to save positions');
        }
    }
}
