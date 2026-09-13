/**
 * Polymarket orderbook WS listener.
 *
 * Subscribes to one or more clob token ids and writes per-slug best bid/ask
 * into a shared `QuoteFeed`. Every update fires per-slug waiters so the
 * cross-market-mm task wakes immediately.
 *
 * Strategy invariant: everything in `QuoteFeed` is YES-frame. When a NO-asset
 * update arrives we invert: YES_ask = 1 - NO_bid, YES_bid = 1 - NO_ask.
 */

import { pino } from 'pino';
import { QuoteFeed } from '../../strategies/cross-market-mm/quote-feed.js';

const logger = pino({ level: process.env.LOG_LEVEL || 'info', name: 'poly-ws' });

const POLYMARKET_WS_URL =
  process.env.POLYMARKET_WS_URL || 'wss://ws-subscriptions-clob.polymarket.com/ws/market';

/**
 * Application-level keepalive. The market stream requires a text frame `PING`
 * every 10 seconds (the server answers `PONG`); protocol-level ping frames do
 * not count and an idle socket gets dropped. Because every PONG is a message,
 * "no message for staleMs" means the socket is dead even on a quiet market,
 * so we close it and let the reconnect loop take over.
 */
export const KEEPALIVE_PING_MS = 10_000;
export const KEEPALIVE_STALE_MS = 30_000;

/** The subset of WebSocket the keepalive touches — lets tests pass a fake. */
export interface KeepaliveSocket {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
}

/**
 * Start the PING loop and the stale-feed watchdog for an open socket.
 * Call `touch()` on every inbound message (PONG included) and `stop()` on
 * close. Exported for tests.
 */
export function attachKeepalive(
  ws: KeepaliveSocket,
  opts: { pingMs?: number; staleMs?: number; now?: () => number } = {},
): { touch: () => void; stop: () => void } {
  const pingMs = opts.pingMs ?? KEEPALIVE_PING_MS;
  const staleMs = opts.staleMs ?? KEEPALIVE_STALE_MS;
  const now = opts.now ?? Date.now;
  const OPEN = 1;
  let lastSeen = now();
  const timer = setInterval(() => {
    if (now() - lastSeen > staleMs) {
      logger.warn({ silentMs: now() - lastSeen }, 'Poly WS stale (no PONG/data) — reconnecting');
      stop();
      try {
        ws.close();
      } catch {
        /* swallow */
      }
      return;
    }
    if (ws.readyState === OPEN) {
      try {
        ws.send('PING');
      } catch {
        /* swallow */
      }
    }
  }, pingMs);
  const stop = () => clearInterval(timer);
  return { touch: () => (lastSeen = now()), stop };
}

interface Level {
  price: string;
  size?: string;
}

interface BookMessage {
  event_type: 'book';
  asset_id: string;
  bids?: Level[];
  buys?: Level[];
  asks?: Level[];
  sells?: Level[];
}

interface PriceChangeMessage {
  event_type: 'price_change';
  asset_id?: string;
  price_changes?: Array<{ asset_id?: string; best_bid?: string; best_ask?: string }>;
  changes?: Array<{ asset_id?: string; best_bid?: string; best_ask?: string }>;
}

type WsMessage = BookMessage | PriceChangeMessage;

/** "Best" bid = max price; "best" ask = min price. */
function bestPrice(levels: Level[] | undefined, side: 'bid' | 'ask'): number | null {
  if (!levels || levels.length === 0) return null;
  const prices: number[] = [];
  for (const lv of levels) {
    const p = Number(lv.price);
    if (Number.isFinite(p)) prices.push(p);
  }
  if (prices.length === 0) return null;
  return side === 'bid' ? Math.max(...prices) : Math.min(...prices);
}

/**
 * Apply a book snapshot. Exported for testability; not part of the runtime
 * surface from `runPolyWs`.
 */
export function applyBook(
  row: BookMessage,
  feed: QuoteFeed,
  assetToSlug: Map<string, string>,
  yesAssets: Set<string>,
): void {
  const assetId = row.asset_id;
  const slug = assetToSlug.get(assetId);
  if (!slug) return;
  const bid = bestPrice(row.bids ?? row.buys, 'bid');
  const ask = bestPrice(row.asks ?? row.sells, 'ask');
  if (yesAssets.has(assetId)) {
    feed.update(slug, bid, ask);
  } else {
    // NO asset → invert to YES frame.
    const yesAsk = bid != null ? 1 - bid : null;
    const yesBid = ask != null ? 1 - ask : null;
    feed.update(slug, yesBid, yesAsk);
  }
}

/**
 * Apply a price_change event. Each event carries one or more changes,
 * each scoped to a single asset_id.
 */
export function applyPriceChange(
  row: PriceChangeMessage,
  feed: QuoteFeed,
  assetToSlug: Map<string, string>,
  yesAssets: Set<string>,
): void {
  const changes = row.price_changes ?? row.changes ?? [];
  for (const ch of changes) {
    const assetId = ch.asset_id ?? row.asset_id;
    if (!assetId) continue;
    const slug = assetToSlug.get(assetId);
    if (!slug) continue;
    const bb = ch.best_bid != null ? Number(ch.best_bid) : null;
    const ba = ch.best_ask != null ? Number(ch.best_ask) : null;
    if (!Number.isFinite(bb) && !Number.isFinite(ba)) continue;
    if (yesAssets.has(assetId)) {
      feed.update(slug, Number.isFinite(bb) ? bb : undefined, Number.isFinite(ba) ? ba : undefined);
    } else {
      const yesAsk = Number.isFinite(bb) ? 1 - (bb as number) : undefined;
      const yesBid = Number.isFinite(ba) ? 1 - (ba as number) : undefined;
      feed.update(slug, yesBid, yesAsk);
    }
  }
}

function handleMessage(
  raw: string,
  feed: QuoteFeed,
  assetToSlug: Map<string, string>,
  yesAssets: Set<string>,
): void {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return;
  }
  const rows = Array.isArray(data) ? (data as WsMessage[]) : [data as WsMessage];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    if ((row as WsMessage).event_type === 'book') {
      applyBook(row as BookMessage, feed, assetToSlug, yesAssets);
    } else if ((row as WsMessage).event_type === 'price_change') {
      applyPriceChange(row as PriceChangeMessage, feed, assetToSlug, yesAssets);
    }
  }
}

/**
 * Connect to Polymarket WS, subscribe to all asset ids, update `feed`.
 *
 * Sends the text `PING` the stream requires every 10s and reconnects when the
 * socket goes silent (see `attachKeepalive`).
 * Reconnects with exponential backoff (capped at 30s). On reconnect we
 * re-send the subscribe — Polymarket's WS does not auto-resubscribe.
 *
 * @param feed shared QuoteFeed
 * @param assetToSlug every (YES + NO) asset_id → polymarket_slug
 * @param yesAssets only the YES asset ids (used to decide inversion)
 */
export async function runPolyWs(
  feed: QuoteFeed,
  assetToSlug: Map<string, string>,
  yesAssets: Set<string>,
  signal?: AbortSignal,
): Promise<void> {
  // Native WebSocket (built into node 22+). agents-starter requires node 22+
  // via @types/node, and the global is available without any import.
  const assetIds = [...assetToSlug.keys()];
  let delay = 1000;

  while (!signal?.aborted) {
    const ws = new WebSocket(POLYMARKET_WS_URL);

    await new Promise<void>((resolve) => {
      let resolved = false;
      let keepalive: ReturnType<typeof attachKeepalive> | null = null;
      const settle = () => {
        keepalive?.stop();
        keepalive = null;
        if (!resolved) {
          resolved = true;
          resolve();
        }
      };

      ws.addEventListener('open', () => {
        ws.send(JSON.stringify({ type: 'market', assets_ids: assetIds }));
        keepalive = attachKeepalive(ws);
        logger.info({ count: assetIds.length }, 'Poly WS connected');
        delay = 1000; // reset backoff on successful connect
      });

      ws.addEventListener('message', (ev: MessageEvent) => {
        keepalive?.touch();
        const raw = typeof ev.data === 'string' ? ev.data : '';
        if (!raw || raw.toLowerCase() === 'pong') return;
        handleMessage(raw, feed, assetToSlug, yesAssets);
      });

      ws.addEventListener('error', () => {
        logger.warn('Poly WS error');
        settle();
      });

      ws.addEventListener('close', () => {
        logger.warn('Poly WS closed');
        settle();
      });

      signal?.addEventListener('abort', () => {
        try {
          ws.close();
        } catch {
          /* swallow */
        }
        settle();
      });
    });

    if (signal?.aborted) break;

    logger.info({ delayMs: delay }, 'reconnecting');
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 2, 30_000);
  }
}
