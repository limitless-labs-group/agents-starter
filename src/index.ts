/**
 * agents-starter CLI — account-level operations that every strategy needs.
 *
 *   npm start doctor [--market <slug>] [--json]   Preflight: key, token, wallet mode, balances, approvals
 *   npm start approve <market-slug>               Approve USDC + CTF for a market's exchange (and adapter)
 *   npm start whoami                              Show the authenticated profile
 *   npm start wallet-mode [eoa|smartWallet]       Show or switch the trading-wallet mode
 *
 * Strategies have their own runners (`npm run <strategy>`); see README.md.
 */

import dotenv from 'dotenv';
dotenv.config({ quiet: true });

import { pino } from 'pino';
import { approveMarketVenue } from './core/limitless/approve.js';
import { PortfolioClient, type TradeWalletMode } from './core/limitless/portfolio.js';
import { formatDoctorReport, runDoctor } from './core/doctor.js';

const logger = pino({ level: process.env.LOG_LEVEL || 'info', name: 'agent-cli' });

const USAGE = `
Usage:
  npm start doctor [--market <slug>] [--json]   Preflight checks (auth, wallet mode, balances, approvals)
  npm start approve <market-slug>               Approve USDC + CTF for the market's exchange (+ adapter)
  npm start whoami                              Print the authenticated profile
  npm start wallet-mode [eoa|smartWallet]       Show or switch the profile's trading-wallet mode

Strategies:
  npm run template                              Bare strategy skeleton (start here to build your own)
  npm run certainty-closer                      SDK-only near-resolution example
  npm run oracle-arb                            Pyth oracle edge-detection
  npm run cross-market-mm                       Cross-venue market making (Limitless ↔ Polymarket)
`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  switch (command) {
    case 'doctor': {
      const report = await runDoctor({ marketSlug: flag(args, '--market') });
      if (args.includes('--json')) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log(formatDoctorReport(report));
      }
      process.exitCode = report.ok ? 0 : 1;
      return;
    }
    case 'approve': {
      const slug = args[1];
      if (!slug) throw new Error('Market slug required: npm start approve <slug>');
      await approveMarketVenue(slug);
      return;
    }
    case 'whoami': {
      const profile = await new PortfolioClient().getProfile();
      console.log(
        JSON.stringify(
          {
            id: profile.id,
            account: profile.account,
            username: profile.username,
            tradeWalletOption: profile.tradeWalletOption,
            feeRateBps: profile.rank?.feeRateBps,
            rank: profile.rank?.name,
          },
          null,
          2,
        ),
      );
      return;
    }
    case 'wallet-mode': {
      const portfolio = new PortfolioClient();
      const target = args[1] as TradeWalletMode | undefined;
      if (!target) {
        console.log(`Trading wallet mode: ${(await portfolio.getTradeWalletMode()) ?? 'unreported'}`);
        return;
      }
      if (target !== 'eoa' && target !== 'smartWallet') {
        throw new Error(`Unknown mode "${target}" — use eoa or smartWallet`);
      }
      const profile = await portfolio.setTradeWalletMode(target);
      console.log(`Trading wallet mode is now: ${profile.tradeWalletOption ?? target}`);
      if (target === 'eoa') {
        console.log('Self-signed API orders will be accepted. In the web app this account now confirms each action with the raw wallet.');
      }
      return;
    }
    case undefined:
    case 'help':
    case '--help':
      console.log(USAGE);
      return;
    default:
      console.error(`Unknown command: ${command}`);
      console.log(USAGE);
      process.exitCode = 1;
  }
}

main().catch((err) => {
  logger.fatal({ err: (err as Error).message }, 'Command failed');
  process.exit(1);
});
