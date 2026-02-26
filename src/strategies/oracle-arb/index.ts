import { BaseStrategy, StrategyConfig, TradeDecision } from '../base-strategy.js';
import { LimitlessClient } from '../../core/limitless/markets.js';
import { TradingClient } from '../../core/limitless/trading.js';
import { HermesClient } from '../../core/price-feeds/hermes.js';
import { createPublicClient, http, parseAbi, formatUnits, PublicClient } from 'viem';
import { base } from 'viem/chains';
import fs from 'fs/promises';
import path from 'path';

const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as const;

// Fallback Base RPC endpoints
const BASE_RPCS = [
    'https://mainnet.base.org',
    'https://base-rpc.publicnode.com',
    'https://base.llamarpc.com',
    'https://base.drpc.org',
];

let rpcIndex = 0;

function getNextRpc(): string {
    const url = BASE_RPCS[rpcIndex];
    rpcIndex = (rpcIndex + 1) % BASE_RPCS.length;
    return url;
}

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

    private baseIntervalMs: number = 10000;
    private goldenIntervalMs: number = 3000;

    constructor(
        config: StrategyConfig,
        deps: { limitless: LimitlessClient; trading: TradingClient }
    ) {
        super(config, deps);
        this.hermes = new HermesClient();
        this.baseIntervalMs = 10000; // Normal: scan every 10s
        this.goldenIntervalMs = 3000; // Golden window: scan every 3s
        this.tickIntervalMs = this.baseIntervalMs;

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
        for (let i = 0; i < BASE_RPCS.length; i++) {
            const rpcUrl = getNextRpc();
            try {
                if (!this.walletAddress) {
                    this.logger.warn('Cannot check balance: wallet address not set');
                    return 0;
                }

                const publicClient = createPublicClient({
                    chain: base,
                    transport: http(rpcUrl),
                });

                const balance = await publicClient.readContract({
                    address: USDC_ADDRESS,
                    abi: parseAbi(['function balanceOf(address) view returns (uint256)']),
                    functionName: 'balanceOf',
                    args: [this.walletAddress as `0x${string}`],
                });

                this.portfolioBalance = parseFloat(formatUnits(balance, 6));
                this.lastBalanceCheck = Date.now();
                this.logger.info({ balance: this.portfolioBalance, rpc: rpcUrl }, 'Wallet USDC balance');
                return this.portfolioBalance;
            } catch (e: any) {
                this.logger.warn({ rpc: rpcUrl, err: e.message }, 'RPC failed, trying next...');
            }
        }
        this.logger.error('All RPCs failed for balance check');
        return this.portfolioBalance;
    }

    /**
     * Check if we're in the "golden window" - the last 3 minutes of each hour
     * when markets are about to expire and resolution is imminent.
     */
    private isGoldenWindow(): boolean {
        const now = new Date();
        const minute = now.getUTCMinutes();
        const second = now.getUTCSeconds();
        // Golden window: xx:57:00 to xx:03:00 (across hour boundary)
        return (minute >= 57) || (minute <= 3);
    }

    /**
     * Adjust tick interval based on time of hour
     */
    private adjustTickInterval(): void {
        const inGoldenWindow = this.isGoldenWindow();
        const targetInterval = inGoldenWindow ? this.goldenIntervalMs : this.baseIntervalMs;
        
        if (this.tickIntervalMs !== targetInterval) {
            this.tickIntervalMs = targetInterval;
            this.logger.info(
                { 
                    interval: `${targetInterval}ms`, 
                    mode: inGoldenWindow ? 'GOLDEN' : 'NORMAL',
                    time: new Date().toISOString()
                }, 
                'Scan frequency adjusted'
            );
        }
    }

    async tick(): Promise<TradeDecision[]> {
        const decisions: TradeDecision[] = [];
        const config = this.config as OracleArbConfig;

        this.tickCount++;

        // Adjust scanning frequency based on time of hour
        this.adjustTickInterval();

        // Continuous scanning mode — golden window gives burst speed (3s vs 10s)
        // but we scan at all times to catch opportunities

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

        // Clean up expired positions from count
        const now = Date.now();
        let expiredCount = 0;
        for (const [slug, pos] of this.positions) {
            // Position timestamp is when we entered - if > 2 hours ago, consider expired
            // Most markets resolve within 1 hour of expiry
            const hoursSinceEntry = (now - pos.timestamp) / (1000 * 60 * 60);
            if (hoursSinceEntry > 2) {
                this.positions.delete(slug);
                expiredCount++;
            }
        }
        if (expiredCount > 0) {
            this.logger.info({ expired: expiredCount, remaining: this.positions.size }, 'Cleaned up expired positions');
            await this.savePositions();
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
                const markets = await this.limitless.searchMarkets(asset, { limit: 50 });
                this.logger.debug({ asset, count: markets.length }, 'Found markets');

                let validMarkets = 0;
                let skippedMarkets = 0;

                for (const market of markets) {
                    // Skip if already traded
                    if (this.tradedMarkets.has(market.slug)) {
                        skippedMarkets++;
                        continue;
                    }

                    // Skip AMM markets (no CLOB)
                    if (market.tradeType !== 'clob') {
                        skippedMarkets++;
                        continue;
                    }

                    // Check expiry window
                    const expiresAt = market.expirationTimestamp;
                    const now = Date.now();
                    const minutesToExpiry = (expiresAt - now) / (1000 * 60);

                    if (minutesToExpiry < config.minMinutesToExpiry ||
                        minutesToExpiry > config.maxMinutesToExpiry) {
                        skippedMarkets++;
                        continue;
                    }
                    
                    validMarkets++;

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

                        // Check orderbook for actual ask price
                        let askPrice = yesPrice + 0.05; // fallback: 5¢ above last trade
                        try {
                            const book = await this.limitless.getOrderbook(market.slug);
                            if (book.asks?.[0]?.price) {
                                askPrice = parseFloat(book.asks[0].price);
                            }
                        } catch { /* use fallback */ }

                        // Bid 1¢ above the ask to ensure fill
                        const fokPrice = Math.min(Math.ceil(askPrice * 100) + 1, 95);

                        this.logger.info({
                            action: 'BUY YES',
                            market: market.title,
                            oraclePrice,
                            strike,
                            yesPrice,
                            askPrice: (askPrice * 100).toFixed(1) + '¢',
                            fokPrice: fokPrice + '¢',
                            oracleYesProb: (oracleYesProb * 100).toFixed(1) + '%',
                            edge: (yesEdge * 100).toFixed(1) + '%',
                        }, 'ORACLE EDGE: BUY YES');

                        const ladder = oracleYesProb >= 0.90 ? [50, 53, 56] : undefined;

                        decisions.push({
                            action: 'BUY',
                            marketSlug: market.slug,
                            side: 'YES',
                            amountUsd: config.betSizeUsd,
                            priceLimit: fokPrice,
                            confidence: oracleYesProb,
                            ladder,
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

                        // Check orderbook for actual NO ask price
                        let noAskPrice = noPrice + 0.05;
                        try {
                            const book = await this.limitless.getOrderbook(market.slug);
                            // NO side asks — need to look at YES bids (complement)
                            if (book.bids?.[0]?.price) {
                                noAskPrice = 1 - parseFloat(book.bids[0].price);
                            }
                        } catch { /* use fallback */ }

                        const fokPrice = Math.min(Math.ceil(noAskPrice * 100) + 1, 95);

                        this.logger.info({
                            action: 'BUY NO',
                            market: market.title,
                            oraclePrice,
                            strike,
                            noPrice,
                            noAskPrice: (noAskPrice * 100).toFixed(1) + '¢',
                            fokPrice: fokPrice + '¢',
                            oracleNoProb: ((1 - oracleYesProb) * 100).toFixed(1) + '%',
                            edge: (noEdge * 100).toFixed(1) + '%',
                        }, 'ORACLE EDGE: BUY NO');

                        const noConf = (1 - oracleYesProb);
                        const ladder = noConf >= 0.90 ? [50, 53, 56] : undefined;

                        decisions.push({
                            action: 'BUY',
                            marketSlug: market.slug,
                            side: 'NO',
                            amountUsd: config.betSizeUsd,
                            priceLimit: fokPrice,
                            confidence: noConf,
                            ladder,
                            reason: `Oracle: ${asset} $${oraclePrice.toFixed(2)} < $${strike} strike (${(noConf * 100).toFixed(0)}% prob). Market NO at ${(noPrice * 100).toFixed(0)}¢`,
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
                
                this.logger.debug({ asset, validMarkets, skippedMarkets, decisions: decisions.length }, 'Asset scan complete');
            } catch (e: any) {
                this.logger.error({ asset, err: e?.message }, 'Error processing asset');
            }
        }

        // Log scan summary at info level every 6th tick (~60s) or when decisions found
        if (decisions.length > 0 || this.tickCount % 6 === 0) {
            this.logger.info({
                tick: this.tickCount,
                decisions: decisions.length,
                positions: this.positions.size,
                traded: this.tradedMarkets.size,
            }, decisions.length > 0 ? 'Trade decisions generated' : 'Scan complete — no opportunities');
        }
        
        return decisions;
    }

    /**
     * Log trade execution for dashboard/history
     */
    private async logTrade(decision: TradeDecision, success: boolean, error?: string): Promise<void> {
        const tradeLog = {
            timestamp: Date.now(),
            marketSlug: decision.marketSlug,
            side: decision.side,
            amountUsd: decision.amountUsd,
            priceLimit: decision.priceLimit,
            success,
            error,
            strategy: 'oracle-arb',
        };
        
        try {
            const logFile = path.join(this.dataDir, 'oracle-arb-trades.jsonl');
            await fs.appendFile(logFile, JSON.stringify(tradeLog) + '\n');
        } catch (e) {
            this.logger.error({ err: e }, 'Failed to log trade');
        }
    }

    /**
     * Override executeDecisions to add auto-approval logic
     */
    protected async executeDecisions(decisions: TradeDecision[]): Promise<void> {
        for (const decision of decisions) {
            if (decision.action === 'SKIP') continue;

            try {
                this.logger.info({ decision }, 'Executing trade decision');

                if (decision.action === 'BUY') {
                    try {
                        const ladder = decision.ladder && decision.ladder.length > 0 ? decision.ladder : [decision.priceLimit];
                        const perOrderUsd = Math.max(0.5, decision.amountUsd / ladder.length);

                        for (const price of ladder) {
                            await this.trading.createOrder({
                                marketSlug: decision.marketSlug,
                                side: decision.side,
                                limitPriceCents: price,
                                usdAmount: perOrderUsd,
                                orderType: 'FOK',
                            });
                        }
                        this.logger.info({ marketSlug: decision.marketSlug, ladder }, 'FOK orders submitted');
                        await this.logTrade(decision, true);
                    } catch (error: any) {
                        const errMsg = error?.message || String(error);
                        
                        // Auto-approve if market not approved
                        if (errMsg.includes('not approved') || errMsg.includes('allowance') || errMsg.includes('Insufficient collateral')) {
                            this.logger.info({ marketSlug: decision.marketSlug }, 'Market not approved, auto-approving...');
                            
                            try {
                                await this.approveMarket(decision.marketSlug);
                                this.logger.info({ marketSlug: decision.marketSlug }, 'Approval complete, retrying order...');
                                
                                const ladder = decision.ladder && decision.ladder.length > 0 ? decision.ladder : [decision.priceLimit];
                                const perOrderUsd = Math.max(0.5, decision.amountUsd / ladder.length);
                                for (const price of ladder) {
                                    await this.trading.createOrder({
                                        marketSlug: decision.marketSlug,
                                        side: decision.side,
                                        limitPriceCents: price,
                                        usdAmount: perOrderUsd,
                                        orderType: 'FOK',
                                    });
                                }
                                this.logger.info({ marketSlug: decision.marketSlug, ladder }, 'FOK orders submitted after approval');
                                await this.logTrade(decision, true);
                            } catch (approvalError: any) {
                                this.logger.error({ err: approvalError?.message, marketSlug: decision.marketSlug }, 'Auto-approval failed');
                                await this.logTrade(decision, false, approvalError?.message);
                            }
                        } else {
                            throw error; // Re-throw if not an approval issue
                        }
                    }
                }
            } catch (error: any) {
                this.logger.error({ err: error?.message || error, decision }, 'Failed to execute decision');
            }
        }
    }

    /**
     * Approve a market for trading (USDC + CTF tokens)
     */
    private async approveMarket(marketSlug: string): Promise<void> {
        const { approveMarketVenue } = await import('../../core/limitless/approve.js');
        await approveMarketVenue(marketSlug);
        this.logger.info({ marketSlug }, 'Market approval complete');
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
