/**
 * Conviction Sniper Strategy
 *
 * Unlike oracle-arb (which fights the market looking for mispricings),
 * this strategy AGREES with the market and uses Hermes/Pyth to add
 * extra oracle conviction before pulling the trigger.
 *
 * Logic:
 *   1. Find markets expiring soon (3–25 min) where one side is already
 *      priced at 65–93¢ (clear leader — outcome is likely, not certain)
 *   2. Use Hermes to confirm the oracle agrees with the market's direction
 *   3. Score conviction = distance-from-strike / oracle-CI
 *      (e.g., BTC $500 below strike + $28 CI = 17.8x conviction)
 *   4. If conviction > threshold: buy the leading side at the market ask
 *
 * Why it works:
 *   Markets at 85–93¢ still carry 7–15¢ of uncertainty premium.
 *   When the oracle is 10x+ its own CI away from the strike, that
 *   uncertainty is mispriced — we capture it.
 */

import { BaseStrategy, StrategyConfig, TradeDecision, StrategyStats } from '../base-strategy.js';
import { LimitlessClient } from '../../core/limitless/markets.js';
import { TradingClient } from '../../core/limitless/trading.js';
import { HermesClient } from '../../core/price-feeds/hermes.js';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_DIR = resolve(__dirname, '../../../data');
const TRADES_FILE = resolve(DATA_DIR, 'conviction-sniper-trades.jsonl');
const POSITIONS_FILE = resolve(DATA_DIR, 'conviction-sniper-positions.json');

export interface ConvictionSniperConfig extends StrategyConfig {
    assets: string[];               // e.g. ['BTC', 'ETH', 'SOL']
    minLeadPrice: number;           // Min price on leading side to consider (e.g. 0.65)
    maxLeadPrice: number;           // Max price — skip near-100¢ (e.g. 0.93)
    minConvictionRatio: number;     // Min (distance-from-strike / oracle-CI), e.g. 3.0
    minOracleAgreement: number;     // Min oracle probability on same side as market (0–1), e.g. 0.60
    minMinutesToExpiry: number;     // e.g. 3
    maxMinutesToExpiry: number;     // e.g. 25
    betSizeUsd: number;             // Per-trade USD size, e.g. 0.50
    maxPositions: number;           // Max concurrent open positions
}

interface Position {
    marketSlug: string;
    side: 'YES' | 'NO';
    entryPrice: number;
    convictionRatio: number;
    oraclePrice: number;
    strike: number;
    timestamp: number;
    amountUsd: number;
}

export class ConvictionSniperStrategy extends BaseStrategy {
    private hermes: HermesClient;
    private tradedMarkets: Set<string> = new Set();
    private positions: Map<string, Position> = new Map();
    private walletAddress: string = '';
    private tickCount = 0;
    private totalTradesPlaced = 0;

    constructor(
        config: StrategyConfig,
        deps: { limitless: LimitlessClient; trading: TradingClient }
    ) {
        super(config, deps);
        this.hermes = new HermesClient();
        this.tickIntervalMs = 10000; // 10s scan
    }

    setWalletAddress(addr: string) {
        this.walletAddress = addr;
    }

    async initialize(): Promise<void> {
        const config = this.config as ConvictionSniperConfig;

        if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

        // Load previously tracked positions
        try {
            if (existsSync(POSITIONS_FILE)) {
                const raw = JSON.parse(readFileSync(POSITIONS_FILE, 'utf8'));
                for (const [slug, pos] of Object.entries(raw)) {
                    this.positions.set(slug, pos as Position);
                    this.tradedMarkets.add(slug);
                }
                this.logger.info({ count: this.positions.size }, 'Loaded positions');
            }
        } catch { /* fresh start */ }

        // Connect Hermes SSE and wait for first prices before scanning
        await this.hermes.connect(config.assets);
        await this.waitForFirstPrices(config.assets, 5000);

        this.logger.info({
            assets: config.assets,
            minLead: config.minLeadPrice,
            maxLead: config.maxLeadPrice,
            minConviction: config.minConvictionRatio,
            minOracleAgreement: config.minOracleAgreement,
            window: `${config.minMinutesToExpiry}–${config.maxMinutesToExpiry}m`,
            betSize: config.betSizeUsd,
        }, 'Conviction Sniper initialized');
    }

    async tick(): Promise<TradeDecision[]> {
        const decisions: TradeDecision[] = [];
        const config = this.config as ConvictionSniperConfig;
        this.tickCount++;

        // Clean up expired positions (> 2h old)
        const now = Date.now();
        for (const [slug, pos] of this.positions) {
            if ((now - pos.timestamp) > 2 * 60 * 60 * 1000) {
                this.positions.delete(slug);
            }
        }

        if (this.positions.size >= config.maxPositions) {
            return decisions;
        }

        for (const asset of config.assets) {
            try {
                const oracleData = this.hermes.getPrice(asset);
                if (!oracleData) {
                    this.logger.debug({ asset }, 'No oracle price yet');
                    continue;
                }

                const { price: oraclePrice, conf: oracleCI } = oracleData;

                // Search active markets for this asset
                const markets = await this.limitless.searchMarkets(asset, { limit: 20 });

                for (const market of markets) {
                    if (market.tradeType !== 'clob') continue;
                    if (this.tradedMarkets.has(market.slug)) continue;

                    const minutesToExpiry = (market.expirationTimestamp - now) / 60000;
                    if (minutesToExpiry < config.minMinutesToExpiry ||
                        minutesToExpiry > config.maxMinutesToExpiry) continue;

                    // Parse strike from market title
                    const strike = this.parseStrike(market.title);
                    if (!strike) continue;

                    // Distance from strike (absolute, in price units)
                    const distFromStrike = Math.abs(oraclePrice - strike);

                    // Conviction ratio: how many oracle CIs away from the strike?
                    // e.g. BTC $500 from strike, CI=$28 → ratio=17.8 (very high)
                    const convictionRatio = oracleCI > 0 ? distFromStrike / oracleCI : 0;

                    // Which direction does oracle point?
                    const oraclePointsYes = oraclePrice > strike;
                    const oraclePointsNo = oraclePrice < strike;

                    // Oracle agreement probability (simple: how far are we from 50/50 on oracle's side?)
                    // Use pct-from-strike as signal strength
                    const pctFromStrike = distFromStrike / strike;
                    // More conservative sigmoid: 0.5 + pct * 20 (capped at 0.95)
                    const oracleProb = Math.min(0.95, 0.5 + pctFromStrike * 20);

                    // Get market prices (from listings — will refine vs orderbook below)
                    const yesPrice = market.prices?.[0] ?? 0.5;
                    const noPrice = market.prices?.[1] ?? 0.5;

                    // Is the market showing a clear leader in our target range?
                    const yesLeading = yesPrice >= config.minLeadPrice && yesPrice <= config.maxLeadPrice;
                    const noLeading = noPrice >= config.minLeadPrice && noPrice <= config.maxLeadPrice;

                    if (!yesLeading && !noLeading) continue;

                    // Oracle must agree with the leading side
                    const targetSide: 'YES' | 'NO' | null =
                        yesLeading && oraclePointsYes ? 'YES' :
                        noLeading && oraclePointsNo ? 'NO' : null;

                    if (!targetSide) continue;

                    // Oracle confidence must clear the bar
                    if (oracleProb < config.minOracleAgreement) {
                        this.logger.debug({
                            market: market.slug,
                            oracleProb: (oracleProb * 100).toFixed(1) + '%',
                            min: (config.minOracleAgreement * 100).toFixed(0) + '%',
                        }, 'Oracle agreement too low, skipping');
                        continue;
                    }

                    // Conviction ratio must clear the bar
                    if (convictionRatio < config.minConvictionRatio) {
                        this.logger.debug({
                            market: market.slug,
                            convictionRatio: convictionRatio.toFixed(1),
                            min: config.minConvictionRatio,
                        }, 'Conviction ratio too low, skipping');
                        continue;
                    }

                    // Check actual orderbook ask for our side
                    let askPrice = targetSide === 'YES' ? yesPrice : noPrice;
                    try {
                        const book = await this.limitless.getOrderbook(market.slug);
                        if (targetSide === 'YES') {
                            if (!book.asks?.length) {
                                this.logger.debug({ market: market.slug }, 'YES: empty asks, skipping');
                                continue;
                            }
                            askPrice = parseFloat(book.asks[0].price);
                        } else {
                            if (!book.bids?.length) {
                                this.logger.debug({ market: market.slug }, 'NO: empty bids, skipping');
                                continue;
                            }
                            askPrice = 1 - parseFloat(book.bids[0].price);
                        }
                    } catch { /* use listing price */ }

                    // Re-check price bounds against actual ask
                    if (askPrice < config.minLeadPrice || askPrice > config.maxLeadPrice) {
                        this.logger.debug({
                            market: market.slug,
                            askPrice: (askPrice * 100).toFixed(0) + '¢',
                        }, 'Ask outside target range, skipping');
                        continue;
                    }

                    // 1¢ above ask to ensure fill
                    const fokPrice = Math.min(Math.ceil(askPrice * 100) + 1, 97);

                    this.logger.info({
                        asset,
                        market: market.title,
                        side: targetSide,
                        oraclePrice: oraclePrice.toFixed(2),
                        strike: strike.toFixed(2),
                        distFromStrike: distFromStrike.toFixed(2),
                        oracleCI: oracleCI.toFixed(2),
                        convictionRatio: convictionRatio.toFixed(1) + 'x',
                        oracleAgreement: (oracleProb * 100).toFixed(1) + '%',
                        askPrice: (askPrice * 100).toFixed(0) + '¢',
                        fokPrice: fokPrice + '¢',
                        minutesToExpiry: minutesToExpiry.toFixed(0) + 'm',
                    }, '🎯 CONVICTION SNIPE');

                    decisions.push({
                        action: 'BUY',
                        marketSlug: market.slug,
                        side: targetSide,
                        amountUsd: config.betSizeUsd,
                        priceLimit: fokPrice,
                        confidence: oracleProb,
                        reason: `${asset} oracle $${oraclePrice.toFixed(2)} vs strike $${strike.toFixed(2)} (${convictionRatio.toFixed(1)}x conviction). Market ${targetSide} at ${(askPrice*100).toFixed(0)}¢`,
                    });

                    // Track position
                    this.positions.set(market.slug, {
                        marketSlug: market.slug,
                        side: targetSide,
                        entryPrice: askPrice,
                        convictionRatio,
                        oraclePrice,
                        strike,
                        timestamp: Date.now(),
                        amountUsd: config.betSizeUsd,
                    });
                    this.tradedMarkets.add(market.slug);
                    await this.savePositions();
                    this.totalTradesPlaced++;
                }
            } catch (err: any) {
                this.logger.error({ asset, err: err.message }, 'Error scanning asset');
            }
        }

        const summary = {
            tick: this.tickCount,
            decisions: decisions.length,
            positions: this.positions.size,
            traded: this.totalTradesPlaced,
        };

        if (decisions.length > 0) {
            this.logger.info(summary, `🎯 ${decisions.length} conviction snipe(s) queued`);
        } else {
            this.logger.info(summary, 'Scan complete — no snipes');
        }

        return decisions;
    }

    async shutdown(): Promise<void> {
        this.hermes.disconnect?.();
        this.logger.info({ positions: this.positions.size }, 'Conviction Sniper shutting down');
    }

    getStats(): StrategyStats {
        return {
            activePositions: this.positions.size,
            totalVolumeUsd: this.totalTradesPlaced * (this.config as ConvictionSniperConfig).betSizeUsd,
            pnlUsd: 0,
            lastTickDurationMs: 0,
        };
    }

    /** Wait until Hermes has streamed at least one price, or timeout */
    private waitForFirstPrices(assets: string[], timeoutMs: number): Promise<void> {
        return new Promise((resolve) => {
            let done = false;
            const finish = (reason: string) => {
                if (done) return;
                done = true;
                this.hermes.off('price', check);
                clearTimeout(timer);
                this.logger.info({ assets, reason }, 'Oracle prices ready');
                resolve();
            };
            const check = () => {
                if (assets.every(a => this.hermes.getPrice(a) !== null)) {
                    finish('all prices received');
                }
            };
            const timer = setTimeout(() => finish('timeout'), timeoutMs);
            this.hermes.on('price', check);
            check(); // in case already cached
        });
    }

    private parseStrike(title: string): number | null {
        // e.g. "$BTC above $67,369.89 on Feb 27, 11:00 UTC?"
        const m = title.match(/\$\s*([\d,]+(?:\.\d+)?)/g);
        if (!m || m.length < 2) return null;
        const val = parseFloat(m[1].replace(/[$,]/g, ''));
        return isNaN(val) ? null : val;
    }

    private async savePositions(): Promise<void> {
        try {
            const obj: Record<string, Position> = {};
            for (const [slug, pos] of this.positions) obj[slug] = pos;
            writeFileSync(POSITIONS_FILE, JSON.stringify(obj, null, 2));
        } catch { /* non-fatal */ }
    }
}
