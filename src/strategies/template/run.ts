#!/usr/bin/env node
/**
 * Template strategy runner. Copy alongside your strategy and adjust config.
 *
 *   npm run template                 # dry run (logs decisions, signs nothing)
 *   DRY_RUN=false npm run template   # live
 */

import dotenv from 'dotenv';
dotenv.config({ quiet: true });

import { pino } from 'pino';
import { createSdkClient, hasAuth, resolveAuth } from '../../core/limitless/client.js';
import { LimitlessClient } from '../../core/limitless/markets.js';
import { SDKTradingClient } from '../../core/limitless/sdk-trading.js';
import { TemplateStrategy, type TemplateConfig } from './index.js';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

async function main(): Promise<void> {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) {
    console.error('ERROR: PRIVATE_KEY not set in .env');
    process.exit(1);
  }
  if (!hasAuth(resolveAuth())) {
    console.error('ERROR: set LMTS_TOKEN_ID + LMTS_TOKEN_SECRET (scoped HMAC token) in .env');
    process.exit(1);
  }

  const dryRun = process.env.DRY_RUN !== 'false';
  console.log(`Template strategy · ${dryRun ? 'DRY RUN (no trades)' : 'LIVE TRADING'}`);

  // One SDK client shared by market reads and order placement.
  const sdk = createSdkClient({ logger });
  const limitless = new LimitlessClient(sdk);
  const trading = new SDKTradingClient({ privateKey, sdk, dryRun });

  const config: TemplateConfig = {
    id: 'template-1',
    type: 'template',
    enabled: true,
    minEdge: Number(process.env.TEMPLATE_MIN_EDGE ?? 0.05),
    orderUsd: Number(process.env.TEMPLATE_ORDER_USD ?? 1),
    maxPositions: Number(process.env.TEMPLATE_MAX_POSITIONS ?? 3),
    maxMinutesToExpiry: Number(process.env.TEMPLATE_MAX_MINUTES ?? 120),
  };

  const strategy = new TemplateStrategy(config, { limitless, trading });

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down...');
    await strategy.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await strategy.start();
  logger.info('Strategy running. Press Ctrl+C to stop.');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
