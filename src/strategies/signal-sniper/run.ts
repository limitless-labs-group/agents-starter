/**
 * Standalone runner for Signal Sniper strategy
 * 
 * Usage: npx tsx src/strategies/signal-sniper/run.ts
 */

import { SignalSniperStrategy } from './index.js';
import { LimitlessClient } from '../../core/limitless/markets.js';
import { TradingClient } from '../../core/limitless/trading.js';
import { OrderSigner } from '../../core/limitless/sign.js';
import { getWallet } from '../../core/wallet.js';
import { appendFileSync } from 'fs';
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
  const { client, account } = getWallet();
  const signer = new OrderSigner(client, account);
  const trading = new TradingClient(limitless, signer);

  // Wrap trading to support dry-run and event logging
  const wrappedTrading = DRY_RUN ? new Proxy(trading, {
    get(target, prop) {
      if (prop === 'createOrder') {
        return async (order: any) => {
          console.log(`[DRY RUN] Would trade: ${order.side} ${order.marketSlug} @ ${order.limitPriceCents}¢, $${order.usdAmount}`);
          appendFileSync('./trade-events.jsonl', JSON.stringify({
            type: 'dry-run',
            timestamp: new Date().toISOString(),
            strategy: 'signal-sniper',
            ...order,
          }) + '\n');
          return { status: 'dry-run' };
        };
      }
      return (target as any)[prop];
    }
  }) : trading;

  const strategy = new SignalSniperStrategy(config, {
    limitless,
    trading: wrappedTrading,
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
