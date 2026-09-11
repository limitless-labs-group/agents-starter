/**
 * place-order — the smallest end-to-end trading flow on the official SDK.
 *
 *   1. Find an active CLOB market with a two-sided book.
 *   2. Place a resting GTC BUY (post-only, so it never crosses).
 *   3. Watch what happens: order events over the websocket, then a positions
 *      read as ground truth.
 *   4. Cancel the order on exit so nothing is left on the book.
 *
 * Run:
 *   npm run example:place-order              # dry run (DRY_RUN=true in .env)
 *   DRY_RUN=false npm run example:place-order
 *
 * Env knobs: SEARCH_QUERY, SIDE (YES|NO), LIMIT_PRICE_CENTS, USD_AMOUNT, KEEP_ORDER=true
 */

import dotenv from 'dotenv';
dotenv.config({ quiet: true });

import { createSdkClient, resolveAuth } from '../core/limitless/client.js';
import { LimitlessClient } from '../core/limitless/markets.js';
import { PortfolioClient } from '../core/limitless/portfolio.js';
import { SDKTradingClient } from '../core/limitless/sdk-trading.js';
import { summarizeExecution } from '../core/limitless/execution.js';
import { LimitlessStream, isOmeEvent } from '../core/limitless/websocket.js';
import { takerDelayMs, type OutcomeSide } from '../core/limitless/types.js';

const SEARCH_QUERY = process.env.SEARCH_QUERY ?? 'BTC';
const SIDE = (process.env.SIDE ?? 'YES') as OutcomeSide;
const LIMIT_PRICE_CENTS = Number(process.env.LIMIT_PRICE_CENTS ?? 0); // 0 = one tick below best bid
const USD_AMOUNT = Number(process.env.USD_AMOUNT ?? 2);
const WATCH_MS = 20_000;

async function main(): Promise<void> {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) throw new Error('PRIVATE_KEY not set in .env');
  const dryRun = process.env.DRY_RUN !== 'false';

  const sdk = createSdkClient();
  const markets = new LimitlessClient(sdk);
  const portfolio = new PortfolioClient(sdk);
  const trading = new SDKTradingClient({ privateKey, sdk, dryRun });
  console.log(`Wallet ${trading.getWalletAddress()} · ${dryRun ? 'DRY RUN' : 'LIVE'}`);

  // 1. Find a market with liquidity on both sides.
  const candidates = (await markets.searchMarkets(SEARCH_QUERY, { limit: 10 })).filter(
    (m) => m.tradeType === 'clob' && m.expirationTimestamp > Date.now(),
  );
  let market = candidates[0];
  let book = market ? await markets.getOrderbook(market.slug) : undefined;
  for (const m of candidates) {
    const b = await markets.getOrderbook(m.slug);
    if (b.bids.length && b.asks.length) {
      market = m;
      book = b;
      break;
    }
  }
  if (!market || !book) {
    console.log(`No active CLOB market found for "${SEARCH_QUERY}"`);
    return;
  }
  console.log(`\nMarket: ${market.title}\n  slug ${market.slug}\n  best bid ${book.bids[0]?.price ?? '-'} · best ask ${book.asks[0]?.price ?? '-'} · taker delay ${takerDelayMs(market)}ms`);

  // 2. Rest a post-only GTC one tick below the best bid (never crosses).
  const bestBidCents = Math.round((book.bids[0]?.price ?? 0.5) * 100);
  const priceCents = LIMIT_PRICE_CENTS || Math.max(1, bestBidCents - 1);
  console.log(`\nPlacing GTC post-only BUY ${SIDE} @ ${priceCents}¢ for $${USD_AMOUNT}`);

  // 3a. Order events (HMAC only) — every OME / settlement frame for your orders.
  const stream = new LimitlessStream();
  const hasHmac = Boolean(resolveAuth().hmacCredentials);
  if (!dryRun && hasHmac) {
    await stream.connect();
    await stream.subscribeOrderEvents();
    stream.onOrderEvent((event) => {
      if (isOmeEvent(event)) {
        console.log(`  [OME ${event.type}${event.status ? ' ' + event.status : ''}] order ${event.orderId} remaining ${event.remainingSize}`);
      } else {
        console.log(`  [SETTLEMENT ${event.type}] order ${event.orderId ?? '-'} tx ${event.txHash ?? '-'}`);
      }
    });
  }

  const res = await trading.createOrder({
    marketSlug: market.slug,
    side: SIDE,
    limitPriceCents: priceCents,
    usdAmount: USD_AMOUNT,
    orderType: 'GTC',
    postOnly: true,
  });
  const summary = summarizeExecution(res, 'GTC');
  console.log(`Order ${res.order.id}: ${summary.settlementStatus ?? 'n/a'} → ${summary.state}`);
  if (dryRun) {
    console.log('\nDry run: nothing was signed or sent. Set DRY_RUN=false to place it for real.');
    return;
  }

  // 3b. Wait, then read the positions snapshot: the ground truth for resting fills.
  console.log(`\nWatching for ${WATCH_MS / 1000}s...`);
  await new Promise((r) => setTimeout(r, WATCH_MS));
  const { filled, shares } = await portfolio.verifyFill(market.slug, SIDE);
  console.log(filled ? `Filled: holding ${shares} ${SIDE} shares.` : 'Not filled yet — the order is resting on the book.');

  // 4. Clean up.
  if (process.env.KEEP_ORDER === 'true') {
    console.log(`Leaving order ${res.order.id} on the book (KEEP_ORDER=true).`);
  } else {
    await trading.cancelOrder(res.order.id);
    console.log(`Cancelled order ${res.order.id}. Set KEEP_ORDER=true to leave it resting.`);
  }
  await stream.disconnect();
}

main().catch((err) => {
  console.error('Fatal:', (err as Error).message);
  process.exit(1);
});
