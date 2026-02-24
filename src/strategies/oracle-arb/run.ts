#!/usr/bin/env node
/**
 * Oracle Arb Strategy Runner
 * 
 * Runs the Hermes Pyth oracle-based arbitrage strategy.
 * This uses sub-second oracle prices to find edge in short-term
 * prediction markets before they resolve.
 * 
 * Usage:
 *   npm run oracle-arb          # Dry run (logs what it would trade)
 *   DRY_RUN=false npm run oracle-arb  # Live trading
 */

import { config } from 'dotenv';
config();

import { getWallet } from '../../core/wallet.js';
import { LimitlessClient } from '../../core/limitless/markets.js';
import { TradingClient } from '../../core/limitless/trading.js';
import { OrderSigner } from '../../core/limitless/sign.js';
import { OracleArbStrategy, type OracleArbConfig } from './index.js';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

async function main() {
    // Validate env
    if (!process.env.PRIVATE_KEY) {
        console.error('❌ PRIVATE_KEY not set in .env');
        process.exit(1);
    }

    if (!process.env.LIMITLESS_API_KEY) {
        console.error('❌ LIMITLESS_API_KEY not set in .env');
        process.exit(1);
    }

    const dryRun = process.env.DRY_RUN !== 'false';
    console.log(`🤖 Oracle Arb Strategy`);
    console.log(`   Mode: ${dryRun ? 'DRY RUN (no trades)' : 'LIVE TRADING'}`);
    console.log(`   Set DRY_RUN=false to enable real orders`);
    console.log();

    // Initialize wallet and clients
    const { client: walletClient, account } = getWallet();
    const walletAddress = account.address;

    logger.info({ address: walletAddress }, 'Wallet initialized');

    const limitless = new LimitlessClient();
    const signer = new OrderSigner(walletClient, account);
    const trading = new TradingClient(limitless, signer);

    // Strategy configuration
    const strategyConfig: OracleArbConfig = {
        id: 'oracle-arb-1',
        type: 'oracle-arb',
        enabled: true,
        // Assets to monitor via Hermes/Pyth
        assets: (process.env.ORACLE_ASSETS || 'BTC,ETH,SOL').split(',').map(s => s.trim()),
        // Minimum oracle confidence (0-1)
        minConfidencePercent: parseFloat(process.env.ORACLE_MIN_CONFIDENCE || '0.75'),
        // Minimum edge between oracle and market (0-1)
        minEdgePercent: parseFloat(process.env.ORACLE_MIN_EDGE || '0.15'),
        // Max price to pay per contract (0-1)
        maxMarketPrice: parseFloat(process.env.ORACLE_MAX_PRICE || '0.70'),
        // Bet size per trade in USD
        betSizeUsd: parseFloat(process.env.ORACLE_BET_SIZE || '1'),
        // Max concurrent positions
        maxPositions: parseInt(process.env.ORACLE_MAX_POSITIONS || '10'),
        // Only trade markets expiring in this window (minutes)
        // Set min to 0 to catch markets right up to expiry
        minMinutesToExpiry: parseInt(process.env.ORACLE_MIN_MINUTES || '0'),
        maxMinutesToExpiry: parseInt(process.env.ORACLE_MAX_MINUTES || '90'),
    };

    logger.info({
        assets: strategyConfig.assets,
        minConfidence: strategyConfig.minConfidencePercent,
        minEdge: strategyConfig.minEdgePercent,
        maxPrice: strategyConfig.maxMarketPrice,
        betSize: strategyConfig.betSizeUsd,
    }, 'Strategy config');

    // Create and start strategy
    const strategy = new OracleArbStrategy(strategyConfig, {
        limitless,
        trading,
    });

    // Set wallet address for balance checking
    strategy.setWalletAddress(walletAddress);

    // Handle graceful shutdown
    const shutdown = async (signal: string) => {
        logger.info({ signal }, 'Shutting down...');
        await strategy.stop();
        process.exit(0);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    // Start
    await strategy.start();

    // Keep running
    logger.info('Strategy running. Press Ctrl+C to stop.');
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
