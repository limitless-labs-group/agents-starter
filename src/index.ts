import * as dotenv from 'dotenv';
dotenv.config();

import { LimitlessClient } from './core/limitless/markets.js';
import { SDKTradingClient } from './core/limitless/sdk-trading.js';
import { approveMarketVenue } from './core/limitless/approve.js';
import { createStrategy } from './strategies/index.js';
import { StrategyConfig } from './strategies/base-strategy.js';
import { pino } from 'pino';

const logger = pino({
    level: process.env.LOG_LEVEL || 'info',
    name: 'agent-cli'
});

async function main() {
    const args = process.argv.slice(2);
    const command = args[0];

    if (!command) {
        console.log(`
Usage:
  npm start <command> [args...]

Commands:
  signal-sniper [assets] [bet-size]   Run CoinGecko momentum strategy
  complement-arb                       Run YES+NO < $1 arb scanner
  approve <market-slug>                Approve tokens for a market
  iterate [report|analyze|markets]     Strategy analysis & iteration

Examples:
  npm start signal-sniper bitcoin,ethereum 2
  npm start complement-arb
  npm start approve my-market-slug
  npm start iterate analyze
        `);
        process.exit(0);
    }

    const limitless = new LimitlessClient();

    try {
        if (command === 'approve') {
            const marketSlug = args[1];
            if (!marketSlug) throw new Error('Market slug required');
            await approveMarketVenue(marketSlug);

        } else if (command === 'signal-sniper') {
            const trading = new SDKTradingClient({
                privateKey: process.env.PRIVATE_KEY!,
                apiKey: process.env.LIMITLESS_API_KEY!,
            });
            const assets = (args[1] || 'bitcoin').split(',').filter(Boolean);
            const betSize = Number(args[2]) || 2;

            const config: StrategyConfig = {
                id: 'sniper-1',
                type: 'signal-sniper',
                enabled: true,
                sources: [{ type: 'coingecko', assets, pollIntervalMs: 30000 }],
                minConfidence: 0.7,
                maxPositionUsd: betSize,
                edgeThresholdPercent: 10
            };

            const strategy = createStrategy(config, { limitless, trading });

            process.on('SIGINT', async () => {
                await strategy.stop();
                process.exit(0);
            });

            await strategy.start();

        } else if (command === 'complement-arb') {
            const trading = new SDKTradingClient({
                privateKey: process.env.PRIVATE_KEY!,
                apiKey: process.env.LIMITLESS_API_KEY!,
            });

            const config: StrategyConfig = {
                id: 'arb-1',
                type: 'cross-market-arb',
                enabled: true,
                maxPositionUsd: parseFloat(args[1] || '10'),
                minSpreadPercent: parseFloat(args[2] || '3'),
                scanIntervalMs: 30000,
            };

            const strategy = createStrategy(config, { limitless, trading });

            process.on('SIGINT', async () => {
                await strategy.stop();
                process.exit(0);
            });

            await strategy.start();

        } else if (command === 'iterate') {
            // Delegate to iterate.ts
            const subCmd = args[1] || 'report';
            process.argv = [process.argv[0], process.argv[1], subCmd];
            await import('./strategies/iterate.js');

        } else {
            console.error(`Unknown command: ${command}`);
            process.exit(1);
        }

        logger.info('Agent running. Press Ctrl+C to stop.');

    } catch (e: any) {
        logger.fatal({ error: e.message }, 'Startup failed');
        process.exit(1);
    }
}

main().catch(console.error);
