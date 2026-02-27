import { LimitlessClient } from '../core/limitless/markets.js';
import { HermesClient } from '../core/price-feeds/hermes.js';
import dotenv from 'dotenv';
dotenv.config();

async function main() {
  const c = new LimitlessClient();
  const hermes = new HermesClient();
  await hermes.connect(['BTC', 'ETH', 'SOL']);
  await new Promise(r => setTimeout(r, 3000)); // wait for first price

  for (const asset of ['BTC', 'ETH', 'SOL']) {
    const oracle = hermes.getPrice(asset);
    console.log(`\n${asset} oracle: $${oracle?.price?.toFixed(2)} (conf: ${oracle?.conf?.toFixed(2)})`);

    const markets = await (c as any).searchMarkets(asset, { limit: 10 });
    const now = Date.now();
    for (const m of markets.filter((m: any) => {
      const mins = (m.expirationTimestamp - now) / 60000;
      return mins > 0 && mins < 120;
    })) {
      const mins = ((m.expirationTimestamp - now) / 60000).toFixed(0);
      const yesP = m.prices?.[0] ?? 0.5;
      const noP = m.prices?.[1] ?? 0.5;
      const strike = parseFloat(m.title?.match(/\$([\d,.]+)/)?.[1]?.replace(',','') || '0');
      const pctFromStrike = oracle ? (oracle.price - strike) / strike : 0;
      const oracleYesProb = pctFromStrike > 0
        ? Math.min(0.95, 0.5 + Math.abs(pctFromStrike) * 40)
        : Math.max(0.05, 0.5 - Math.abs(pctFromStrike) * 40);
      const noEdge = (1 - oracleYesProb) - noP;
      const yesEdge = oracleYesProb - yesP;
      console.log(`  ${mins}m | YES=${(yesP*100).toFixed(0)}¢ NO=${(noP*100).toFixed(0)}¢ | oracle=${(oracleYesProb*100).toFixed(1)}% YES | noEdge=${(noEdge*100).toFixed(1)}% yesEdge=${(yesEdge*100).toFixed(1)}% | tradeType=${m.tradeType} | ${m.title}`);
    }
  }
  process.exit(0);
}
main().catch(console.error);
