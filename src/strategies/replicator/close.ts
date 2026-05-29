/**
 * close — flatten held POSITIONS on BOTH venues for the configured pairs.
 *
 *   npm run replicator:close
 *
 * The programmatic exit the BUY-only quoting loop otherwise lacks. For each
 * pair it cancels all resting Limitless orders, then SELLS held inventory on
 * BOTH Limitless and Polymarket back to flat, and verifies 0 positions / 0
 * orphan orders on both venues. Loops with settle delays so backend lag can't
 * leave a stranded leg.
 *
 * Requires the one-time approvals: `npm start approve <slug>` (Limitless) and
 * `npm run replicator:setup-poly` (Poly deposit wallet, incl. CTF sell-approval).
 */

import 'dotenv/config';
import { SDKTradingClient } from '../../core/limitless/sdk-trading.js';
import { LimitlessClient } from '../../core/limitless/markets.js';
import { PolymarketAdapter } from '../../core/polymarket/client.js';
import { flattenBothVenues } from './flatten-positions.js';
import { loadSettings } from './config.js';

async function main(): Promise<void> {
  const s = loadSettings();
  const trading = new SDKTradingClient({
    privateKey: s.privateKey,
    ...(s.hmacCredentials ? { hmacCredentials: s.hmacCredentials } : { apiKey: s.lmtsApiKey }),
    dryRun: false, // close is always a real sell
  });
  const md = new LimitlessClient();
  const poly = new PolymarketAdapter({
    privateKey: s.privateKey,
    funder: s.polyFunder,
    signatureType: s.polySignatureType,
    dryRun: false,
  });
  await poly.authProbe();

  const results = await flattenBothVenues(trading, md, poly, s.pairs);
  let allFlat = true;
  for (const r of results) {
    if (!r.flat) allFlat = false;
    const lFlat = r.limitless.yes < 0.5 && r.limitless.no < 0.5;
    const pFlat = r.polymarket.yes < 0.5 && r.polymarket.no < 0.5;
    console.log(
      `${r.slug}\n` +
        `  Limitless:  YES ${r.limitless.yes.toFixed(2)} / NO ${r.limitless.no.toFixed(2)} ${lFlat ? '(FLAT)' : '(holding — re-run)'}\n` +
        `  Polymarket: YES ${r.polymarket.yes.toFixed(2)} / NO ${r.polymarket.no.toFixed(2)} ${pFlat ? '(FLAT)' : '(holding — re-run)'}`,
    );
  }
  if (!allFlat) {
    console.error('\nSome positions could not be fully closed (thin book?) — re-run to retry.');
    process.exit(1);
  }
  console.log('\nAll configured pairs flat on both venues.');
}

main().catch((e: unknown) => {
  console.error('close failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});
