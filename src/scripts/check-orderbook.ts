import { LimitlessClient } from '../core/limitless/markets.js';
import dotenv from 'dotenv';
dotenv.config();

async function main() {
  const c = new LimitlessClient();
  const markets = await (c as any).getActiveMarkets();
  const now = Date.now();
  const relevant = markets.filter((m: any) => {
    const minsLeft = (m.expirationTimestamp - now) / 60000;
    return minsLeft > 0 && minsLeft < 120 &&
      (m.title?.includes('BTC') || m.title?.includes('ETH') || m.title?.includes('SOL'));
  });

  for (const m of relevant.slice(0, 3)) {
    const minsLeft = ((m.expirationTimestamp - now) / 60000).toFixed(0);
    try {
      const book = await (c as any).getOrderbook(m.slug);
      console.log(`\n${minsLeft}m | ${m.title}`);
      console.log(`  asks (${book.asks?.length ?? 0}):`, JSON.stringify(book.asks?.slice(0,3) ?? []));
      console.log(`  bids (${book.bids?.length ?? 0}):`, JSON.stringify(book.bids?.slice(0,3) ?? []));
    } catch(e: any) {
      console.log(`${minsLeft}m | ${m.title} → orderbook error: ${e.message}`);
    }
  }
}
main().catch(console.error);
