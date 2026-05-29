/**
 * flatten — cancel ALL resting Limitless orders for the configured pairs.
 *
 *   npm run cross-market-mm:flatten
 *
 * A manual kill switch / recovery tool: if a run was killed ungracefully and
 * left orders resting, or you just want a clean book, run this. Uses the same
 * verify-and-retry cancel the bot uses on shutdown. Does not touch positions
 * (the strategy only ever BUYs; positions ride to resolution or are hedged).
 */

import 'dotenv/config';
import { SDKTradingClient } from '../../core/limitless/sdk-trading.js';
import { loadSettings } from './config.js';

async function main(): Promise<void> {
  const s = loadSettings();
  const trading = new SDKTradingClient({
    privateKey: s.privateKey,
    ...(s.hmacCredentials ? { hmacCredentials: s.hmacCredentials } : { apiKey: s.lmtsApiKey }),
    dryRun: false, // flatten is always a real cancel
  });

  let allClean = true;
  for (const pair of s.pairs) {
    const before = await trading.countLiveOrders(pair.limitlessSlug);
    const res = await trading.cancelAllAndVerify(pair.limitlessSlug, 8);
    if (res.remaining !== 0) allClean = false;
    console.log(`${pair.limitlessSlug}: ${before} live → ${res.remaining} remaining (${res.message})`);
  }
  if (!allClean) {
    console.error('\nSome orders could not be confirmed cancelled — re-run to retry.');
    process.exit(1);
  }
  console.log('\nAll configured pairs flat.');
}

main().catch((e: unknown) => {
  console.error('flatten failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});
