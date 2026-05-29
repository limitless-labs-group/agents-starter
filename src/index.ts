import * as dotenv from 'dotenv';
dotenv.config();

import { approveMarketVenue } from './core/limitless/approve.js';
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
  approve <market-slug>                Approve a market's exchange (USDC + CTF)

Strategies have their own runners:
  npm run cross-market-mm              Cross-venue market making
  npm run oracle-arb                   Pyth oracle edge-detection
  npm run certainty-closer             SDK-only near-resolution example

Examples:
  npm start approve my-market-slug
        `);
        process.exit(0);
    }

    try {
        if (command === 'approve') {
            const marketSlug = args[1];
            if (!marketSlug) throw new Error('Market slug required');
            await approveMarketVenue(marketSlug);

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
