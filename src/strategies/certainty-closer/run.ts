#!/usr/bin/env node

/**
 * Certainty Closer runner.
 *
 *   npm run certainty-closer            # dry run (logs candidates, no orders)
 *   DRY_RUN=false npm run certainty-closer
 *
 * SDK-only, no external feeds. See ./index.ts for the honest framing — on its
 * own this has no independent edge; the edge is the `assumedEdge` you assert.
 */

import { config } from 'dotenv';
config();

import { LimitlessClient } from '../../core/limitless/markets.js';
import { SDKTradingClient } from '../../core/limitless/sdk-trading.js';
import { CertaintyCloserStrategy, type CertaintyCloserConfig } from './index.js';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

async function main() {
  if (!process.env.PRIVATE_KEY) {
    console.error('ERROR: PRIVATE_KEY not set in .env');
    process.exit(1);
  }
  // Auth: scoped HMAC token (preferred) or legacy X-API-Key. SDKTradingClient
  // picks up LMTS_TOKEN_ID/LMTS_TOKEN_SECRET from env automatically.
  if (!process.env.LIMITLESS_API_KEY && !(process.env.LMTS_TOKEN_ID && process.env.LMTS_TOKEN_SECRET)) {
    console.error('ERROR: set LMTS_TOKEN_ID + LMTS_TOKEN_SECRET (scoped HMAC token) or legacy LIMITLESS_API_KEY in .env');
    process.exit(1);
  }

  const dryRun = process.env.DRY_RUN !== 'false';
  process.env.DRY_RUN = dryRun ? 'true' : 'false';
  console.log('🎯 Certainty Closer');
  console.log(`   Mode: ${dryRun ? 'DRY RUN (no trades)' : 'LIVE TRADING'}`);
  console.log('   SDK-only near-resolution favourite buyer (teaching example)');
  console.log();

  const limitless = new LimitlessClient();
  const trading = new SDKTradingClient({ privateKey: process.env.PRIVATE_KEY! });
  logger.info({ address: trading.getWalletAddress() }, 'Wallet initialized');

  const strategyConfig: CertaintyCloserConfig = {
    id: 'certainty-closer-1',
    type: 'certainty-closer',
    enabled: true,
    minLeadPrice: parseFloat(process.env.CC_MIN_LEAD || '0.85'),
    maxLeadPrice: parseFloat(process.env.CC_MAX_LEAD || '0.97'),
    minMinutesToExpiry: parseInt(process.env.CC_MIN_MINUTES || '0'),
    maxMinutesToExpiry: parseInt(process.env.CC_MAX_MINUTES || '30'),
    assumedEdge: parseFloat(process.env.CC_ASSUMED_EDGE || '0.03'),
    bankrollUsd: parseFloat(process.env.CC_BANKROLL || '50'),
    kellyFraction: parseFloat(process.env.CC_KELLY_FRACTION || '0.25'),
    maxRiskUsd: parseFloat(process.env.CC_MAX_RISK || '2'),
    maxPositions: parseInt(process.env.CC_MAX_POSITIONS || '5'),
  };

  const strategy = new CertaintyCloserStrategy(strategyConfig, { limitless, trading });

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

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
