/**
 * stream-orderbook — live orderbooks over the websocket, plus your own order
 * events when HMAC credentials are configured.
 *
 *   npm run example:stream                     # top 3 CLOB markets ending soon
 *   npm run example:stream <slug> [<slug> ...] # specific markets
 *
 * What to expect: right after the subscription ack the server pushes one
 * `orderbookUpdate` per slug with the full current book (the initial
 * snapshot), then a frame on every change. No REST call is needed to seed
 * local state. Ctrl+C to stop.
 */

import dotenv from 'dotenv';
dotenv.config({ quiet: true });

import { resolveAuth } from '../core/limitless/client.js';
import { LimitlessClient } from '../core/limitless/markets.js';
import { LimitlessStream, isOmeEvent } from '../core/limitless/websocket.js';

async function main(): Promise<void> {
  let slugs = process.argv.slice(2);
  if (slugs.length === 0) {
    const markets = await new LimitlessClient().getActiveMarkets({ tradeType: 'clob', limit: 3, sortBy: 'ending_soon' });
    slugs = markets.map((m) => m.slug);
  }
  if (slugs.length === 0) {
    console.log('No CLOB markets to stream.');
    return;
  }

  const stream = new LimitlessStream();
  const seen = new Set<string>();

  stream.onOrderbook(({ marketSlug, orderbook }) => {
    const kind = seen.has(marketSlug) ? 'update  ' : 'snapshot';
    seen.add(marketSlug);
    const bid = orderbook.bids[0]?.price ?? '-';
    const ask = orderbook.asks[0]?.price ?? '-';
    console.log(`${new Date().toISOString()} ${kind} ${marketSlug}  bid ${bid}  ask ${ask}  (${orderbook.bids.length}/${orderbook.asks.length} levels)`);
  });

  await stream.connect();
  await stream.subscribeMarkets(slugs);
  console.log(`Subscribed to ${slugs.length} market(s): ${slugs.join(', ')}`);

  if (resolveAuth().hmacCredentials) {
    await stream.subscribeOrderEvents();
    stream.onOrderEvent((event) => {
      if (isOmeEvent(event)) {
        console.log(`  order-event OME ${event.type} ${event.orderId} price ${event.price} remaining ${event.remainingSize}`);
      } else {
        console.log(`  order-event SETTLEMENT ${event.type} ${event.orderId ?? '-'} tx ${event.txHash ?? '-'}`);
      }
    });
    console.log('Also streaming your order events (HMAC).');
  } else {
    console.log('No HMAC token configured: streaming public orderbooks only.');
  }

  const stop = async () => {
    await stream.disconnect();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
}

main().catch((err) => {
  console.error('Fatal:', (err as Error).message);
  process.exit(1);
});
