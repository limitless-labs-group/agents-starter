/**
 * Standalone runner for Signal Sniper strategy
 * 
 * Usage: npx tsx src/strategies/signal-sniper/run.ts
 */

import { SignalSniperStrategy } from './index.js';
import { LimitlessClient } from '../../core/limitless/markets.js';
import { SDKTradingClient } from '../../core/limitless/sdk-trading.js';
import dotenv from 'dotenv';

dotenv.config();

const DRY_RUN = process.env.DRY_RUN === 'true';

const config = {
  id: process.env.SNIPER_EXPERIMENT || 'signal-sniper-v1',
  type: 'signal-sniper',
  enabled: true,
  maxPositionUsd: parseFloat(process.env.SNIPER_BET_SIZE || '0.50'),
  edgeThresholdPercent: parseFloat(process.env.SNIPER_MIN_EDGE || '10'),
  sources: [{
    type: 'coingecko' as const,
    assets: (process.env.SNIPER_ASSETS || 'bitcoin,ethereum,solana,dogecoin').split(','),
    pollIntervalMs: 30000,
  }],
  minConfidence: 0.1,
};

async function main() {
  console.log(`
╔══════════════════════════════════════════════╗
║         SIGNAL SNIPER STRATEGY               ║
║  CoinGecko Signals • Edge Detection          ║
╚══════════════════════════════════════════════╝
  
  Assets:     ${config.sources[0].assets.join(', ')}
  Edge:       >${config.edgeThresholdPercent}%
  Bet size:   $${config.maxPositionUsd}
  Mode:       ${DRY_RUN ? 'DRY RUN' : 'LIVE'}
`);

  const limitless = new LimitlessClient();
  const trading = new SDKTradingClient({
    privateKey: process.env.PRIVATE_KEY!,
  });

  const strategy = new SignalSniperStrategy(config, {
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
