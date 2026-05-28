/**
 * close — flatten held POSITIONS for the configured pairs by SELLING all YES
 * and NO inventory back to the book.
 *
 *   npm run replicator:close
 *
 * Complements `flatten` (which only cancels resting orders): this sells the
 * tokens you actually hold, so you end delta-flat without waiting for
 * resolution. The programmatic exit the BUY-only quoting loop otherwise lacks
 * — use it if a fill left you with inventory the hedger couldn't neutralise,
 * or to wind down before stopping.
 *
 * Sells FAK at (bid - slippage) so it takes resting liquidity with bounded
 * slippage; loops until flat or no more fills. Requires the one-time CTF
 * approval for the market's exchange + adapter (`npm start approve <slug>`).
 */

import 'dotenv/config';
import { SDKTradingClient } from '../../core/limitless/sdk-trading.js';
import { LimitlessClient } from '../../core/limitless/markets.js';
import { loadSettings } from './config.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SLIPPAGE_CENTS = 3; // sell up to 3c through the bid
const MIN_SHARES = 0.5; // ignore dust
const MAX_ROUNDS = 4;

async function closePair(
  trading: SDKTradingClient,
  md: LimitlessClient,
  slug: string,
): Promise<{ yes: number; no: number }> {
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const { yes, no } = await trading.getPositionTokens(slug);
    if (yes < MIN_SHARES && no < MIN_SHARES) return { yes, no };

    const ob = (await md.getOrderbook(slug)) as unknown as {
      bids?: Array<{ price: string | number }>;
      asks?: Array<{ price: string | number }>;
    };
    const bids = (ob.bids ?? []).map((l) => Number(l.price)).sort((a, b) => b - a);
    const asks = (ob.asks ?? []).map((l) => Number(l.price)).filter((p) => p < 0.97).sort((a, b) => a - b);
    const yesBid = bids[0] ?? 0.4;
    const yesAsk = asks[0] ?? 0.46;
    const noBid = Math.max(0.02, Math.round((1 - yesAsk) * 100) / 100); // NO bid ≈ 1 - YES ask

    if (yes >= MIN_SHARES) {
      const px = Math.max(2, Math.round(yesBid * 100) - SLIPPAGE_CENTS);
      await trading
        .sellShares({ marketSlug: slug, side: 'YES', shares: yes, limitPriceCents: px, orderType: 'FAK' })
        .catch((e: unknown) => console.error(`  YES sell failed: ${e instanceof Error ? e.message : e}`));
      await sleep(2500);
    }
    if (no >= MIN_SHARES) {
      const px = Math.max(2, Math.round(noBid * 100) - SLIPPAGE_CENTS);
      await trading
        .sellShares({ marketSlug: slug, side: 'NO', shares: no, limitPriceCents: px, orderType: 'FAK' })
        .catch((e: unknown) => console.error(`  NO sell failed: ${e instanceof Error ? e.message : e}`));
      await sleep(2500);
    }
  }
  return trading.getPositionTokens(slug);
}

async function main(): Promise<void> {
  const s = loadSettings();
  const trading = new SDKTradingClient({
    privateKey: s.privateKey,
    ...(s.hmacCredentials ? { hmacCredentials: s.hmacCredentials } : { apiKey: s.lmtsApiKey }),
    dryRun: false, // close is always a real sell
  });
  const md = new LimitlessClient();

  let allFlat = true;
  for (const pair of s.pairs) {
    // Cancel resting orders first so they don't refill while we close.
    await trading.cancelAllAndVerify(pair.limitlessSlug, 8);
    const { yes, no } = await closePair(trading, md, pair.limitlessSlug);
    const flat = yes < MIN_SHARES && no < MIN_SHARES;
    if (!flat) allFlat = false;
    console.log(`${pair.limitlessSlug}: YES ${yes.toFixed(2)} / NO ${no.toFixed(2)} ${flat ? '(FLAT)' : '(still holding — re-run)'}`);
  }
  if (!allFlat) {
    console.error('\nSome positions could not be fully closed (thin book?) — re-run to retry.');
    process.exit(1);
  }
  console.log('\nAll configured pairs flat.');
}

main().catch((e: unknown) => {
  console.error('close failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});
