import { LimitlessClient } from '../core/limitless/markets.js';
import dotenv from 'dotenv';
dotenv.config();

async function main() {
  const c = new LimitlessClient();
  const markets = await (c as any).getActiveMarkets();
  const now = Date.now();
  const relevant = markets.filter((m: any) => {
    const exp = m.expirationTimestamp;
    const minsLeft = (exp - now) / 60000;
    return minsLeft > 0 && minsLeft < 120 &&
      (m.title?.includes('BTC') || m.title?.includes('ETH') || m.title?.includes('SOL'));
  });
  console.log('Active BTC/ETH/SOL markets in next 2h:', relevant.length);
  for (const m of relevant) {
    const minsLeft = ((m.expirationTimestamp - now) / 60000).toFixed(0);
    const yesPrice = parseFloat(m.outcomes?.[0]?.price ?? m.yesPrice ?? '0.5');
    console.log(`  ${String(minsLeft).padStart(3)}m | YES=${(yesPrice*100).toFixed(0)}¢ NO=${((1-yesPrice)*100).toFixed(0)}¢ | ${m.title}`);
  }
}
main().catch(console.error);
