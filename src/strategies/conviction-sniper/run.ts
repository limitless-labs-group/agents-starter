#!/usr/bin/env node

process.on('uncaughtException', (err) => {
    console.error('[UNCAUGHT]', err.message);
});
process.on('unhandledRejection', (err: any) => {
    console.error('[UNHANDLED]', err?.message || err);
});

/**
 * Conviction Sniper Runner
 *
 * Agrees with the market + uses Hermes oracle as conviction booster.
 * Targets markets 3–25 min before expiry where one side is 65–93¢.
 * Oracle confirms direction and adds a conviction ratio score.
 *
 * Usage:
 *   npm run conviction-sniper            # Dry run
 *   DRY_RUN=false npm run conviction-sniper  # Live trading
 */

import { config } from 'dotenv';
config();

import { getWallet } from '../../core/wallet.js';
import { LimitlessClient } from '../../core/limitless/markets.js';
import { TradingClient } from '../../core/limitless/trading.js';
import { OrderSigner } from '../../core/limitless/sign.js';
import { ConvictionSniperStrategy, type ConvictionSniperConfig } from './index.js';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

async function main() {
    if (!process.env.PRIVATE_KEY) {
        console.error('ERROR: PRIVATE_KEY not set in .env');
        process.exit(1);
    }
    if (!process.env.LIMITLESS_API_KEY) {
        console.error('ERROR: LIMITLESS_API_KEY not set in .env');
        process.exit(1);
    }

    const dryRun = process.env.DRY_RUN !== 'false';
    console.log('🎯 Conviction Sniper');
    console.log(`   Mode: ${dryRun ? 'DRY RUN (no trades)' : 'LIVE TRADING'}`);
    console.log(`   Agrees with market + Hermes conviction boost`);
    console.log();

    const { client: walletClient, account } = getWallet();
    logger.info({ address: account.address }, 'Wallet initialized');

    const limitless = new LimitlessClient();
    const signer = new OrderSigner(walletClient, account);
    const trading = new TradingClient(limitless, signer);

    const strategyConfig: ConvictionSniperConfig = {
        id: 'conviction-sniper-1',
        type: 'conviction-sniper',
        enabled: true,

        // Assets to monitor
        assets: (process.env.SNIPER_ASSETS || 'BTC,ETH,SOL').split(',').map(s => s.trim()),

        // Market price range for the leading side (65–93¢)
        // Below 65¢: not clear enough yet
        // Above 93¢: too certain, tiny return
        minLeadPrice: parseFloat(process.env.SNIPER_MIN_LEAD || '0.65'),
        maxLeadPrice: parseFloat(process.env.SNIPER_MAX_LEAD || '0.93'),

        // Conviction ratio: (distance from strike) / (oracle CI)
        // 3x = oracle is 3 confidence-intervals away from strike (reasonably certain)
        // Higher = only trade slam-dunks
        minConvictionRatio: parseFloat(process.env.SNIPER_MIN_CONVICTION || '3.0'),

        // Oracle must agree with market direction with this confidence
        minOracleAgreement: parseFloat(process.env.SNIPER_MIN_AGREEMENT || '0.60'),

        // Only trade markets expiring in this window
        minMinutesToExpiry: parseInt(process.env.SNIPER_MIN_MINUTES || '3'),
        maxMinutesToExpiry: parseInt(process.env.SNIPER_MAX_MINUTES || '25'),

        // Bet size per trade
        betSizeUsd: parseFloat(process.env.SNIPER_BET_SIZE || '0.50'),

        // Max concurrent positions
        maxPositions: parseInt(process.env.SNIPER_MAX_POSITIONS || '10'),
    };

    logger.info({
        assets: strategyConfig.assets,
        leadRange: `${(strategyConfig.minLeadPrice * 100).toFixed(0)}–${(strategyConfig.maxLeadPrice * 100).toFixed(0)}¢`,
        minConviction: strategyConfig.minConvictionRatio + 'x',
        minAgreement: (strategyConfig.minOracleAgreement * 100).toFixed(0) + '%',
        window: `${strategyConfig.minMinutesToExpiry}–${strategyConfig.maxMinutesToExpiry}m`,
        betSize: strategyConfig.betSizeUsd,
    }, 'Strategy config');

    const strategy = new ConvictionSniperStrategy(strategyConfig, { limitless, trading });
    strategy.setWalletAddress(account.address);

    const shutdown = async (signal: string) => {
        logger.info({ signal }, 'Shutting down...');
        await strategy.stop();
        process.exit(0);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    await strategy.start();
    logger.info('Strategy running. Press Ctrl+C to stop.');
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
