/**
 * Standalone runner for Binary Complement Arb strategy
 * 
 * Scans Limitless markets for YES+NO < $1 opportunities.
 * When found, buys both sides for guaranteed profit at resolution.
 * 
 * Usage: npx tsx src/strategies/cross-market-arb/run.ts
 */

import { ComplementArbStrategy } from './index.js';
import { LimitlessClient } from '../../core/limitless/markets.js';
import { SDKTradingClient } from '../../core/limitless/sdk-trading.js';
import dotenv from 'dotenv';

dotenv.config();

const DRY_RUN = process.env.DRY_RUN !== 'false';
process.env.DRY_RUN = DRY_RUN ? 'true' : 'false';

const config = {
  id: 'complement-arb-v1',
  type: 'cross-market-arb',
  enabled: true,
  maxPositionUsd: parseFloat(process.env.ARB_BET_SIZE || '10'),
  minSpreadPercent: parseFloat(process.env.ARB_MIN_SPREAD || '3'),
  scanIntervalMs: parseInt(process.env.ARB_SCAN_INTERVAL || '30000'),
};

async function main() {
  console.log(`
╔══════════════════════════════════════════════╗
║     BINARY COMPLEMENT ARB STRATEGY           ║
║  YES + NO < $1 = Guaranteed Profit           ║
╚══════════════════════════════════════════════╝
  
  Min spread: ${config.minSpreadPercent}%
  Bet size:   $${config.maxPositionUsd}
  Interval:   ${config.scanIntervalMs / 1000}s
  Mode:       ${DRY_RUN ? 'DRY RUN' : 'LIVE'}
`);

  const limitless = new LimitlessClient();
  const trading = new SDKTradingClient({
    privateKey: process.env.PRIVATE_KEY!,
  });

  const strategy = new ComplementArbStrategy(config, {
    limitless,
    trading,
  });

  process.on('SIGINT', async () => {
    await strategy.stop();
    process.exit(0);
  });
  process.on('SIGTERM', async () => {
    await strategy.stop();
    process.exit(0);
  });

  await strategy.start();
}

main().catch(e => {
  console.error('Fatal:', e.message);
  process.exit(1);
});
