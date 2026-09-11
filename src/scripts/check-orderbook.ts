/**
 * check-orderbook — top of book for the soonest-expiring crypto markets.
 *
 *   npx tsx src/scripts/check-orderbook.ts [slug ...]
 *
 * With no arguments it lists CLOB markets ending soon whose title mentions
 * BTC / ETH / SOL and prints the best three levels each side. Pass slugs to
 * inspect specific markets. No auth needed.
 */

import dotenv from 'dotenv';
dotenv.config({ quiet: true });

import { LimitlessClient } from '../core/limitless/markets.js';

/** Orderbook `size` is in raw 6-decimal units; show shares. */
const shares = (raw: number) => (raw / 1e6).toLocaleString('en-US', { maximumFractionDigits: 3 });

async function main(): Promise<void> {
  const client = new LimitlessClient();
  let slugs = process.argv.slice(2);

  if (slugs.length === 0) {
    const markets = await client.getActiveMarkets({ tradeType: 'clob', limit: 25, sortBy: 'ending_soon' });
    const now = Date.now();
    slugs = markets
      .filter((m) => {
        const minsLeft = (m.expirationTimestamp - now) / 60_000;
        return minsLeft > 0 && minsLeft < 180 && /\b(BTC|ETH|SOL)\b/.test(m.title ?? '');
      })
      .slice(0, 3)
      .map((m) => m.slug);
    if (slugs.length === 0) {
      console.log('No BTC/ETH/SOL CLOB markets expiring within 3h. Pass a slug explicitly.');
      return;
    }
  }

  for (const slug of slugs) {
    try {
      const [market, book] = await Promise.all([client.getMarket(slug), client.getOrderbook(slug)]);
      const minsLeft = ((market.expirationTimestamp - Date.now()) / 60_000).toFixed(0);
      const bestBid = book.bids[0]?.price ?? null;
      const bestAsk = book.asks[0]?.price ?? null;
      const spread = bestBid !== null && bestAsk !== null ? (bestAsk - bestBid).toFixed(3) : 'n/a';
      console.log(`\n${market.title}  (${slug})  ${minsLeft}m left`);
      console.log(`  best bid ${bestBid ?? '-'} · best ask ${bestAsk ?? '-'} · spread ${spread} · midpoint ${book.adjustedMidpoint} · last ${book.lastTradePrice ?? '-'}`);
      console.log(`  bids (${book.bids.length}):`, book.bids.slice(0, 3).map((l) => `${l.price} × ${shares(l.size)}`).join('  '));
      console.log(`  asks (${book.asks.length}):`, book.asks.slice(0, 3).map((l) => `${l.price} × ${shares(l.size)}`).join('  '));
      if (book.bids.length === 0 || book.asks.length === 0) {
        console.log('  ! one-sided or empty book — a FOK/FAK into it will not fill');
      }
    } catch (e) {
      console.log(`${slug} → error: ${(e as Error).message}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
