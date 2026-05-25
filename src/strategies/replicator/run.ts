/**
 * Replicator entry point — `npm run replicator`.
 *
 * Wires up:
 *   1. Loads .env + replicator.config.yaml.
 *   2. Constructs SDKTradingClient (Limitless side, EIP-712 signing).
 *   3. Constructs PolymarketAdapter (Polymarket side, FAK hedge).
 *   4. Runs both auth probes (Limitless login + Polymarket deriveApiKey)
 *      BEFORE quoting starts. Catches wrong signatureType / wrong funder
 *      in 2 seconds instead of after fills accumulate.
 *   5. Resolves market metadata on both venues for each pair.
 *   6. Spawns Poly WS task + N replicator tasks + 1 hedger task.
 *   7. Awaits SIGINT/SIGTERM, then cancels everything (replicators
 *      cancel-all on the way out).
 *
 * Port of `main.py` from limitless-replicator.
 */

import { pino } from 'pino';
import { Client, HttpClient } from '@limitless-exchange/sdk';
import { SDKTradingClient } from '../../core/limitless/sdk-trading.js';
import { PolymarketAdapter } from '../../core/polymarket/client.js';
import { runPolyWs } from '../../core/polymarket/ws.js';
import { QuoteFeed } from './quote-feed.js';
import { runReplicator } from './index.js';
import { runHedger } from './hedger.js';
import { loadSettings } from './config.js';
import type { MarketPair } from './types.js';

const logger = pino({ level: process.env.LOG_LEVEL || 'info', name: 'replicator-main' });

/**
 * Resolve Limitless market metadata for a pair: YES/NO token ids +
 * exchange contract (default CTF vs neg-risk).
 */
async function resolveLimitlessMarket(sdk: Client, pair: MarketPair): Promise<void> {
  // The SDK's MarketFetcher.getMarket returns the venue (with .exchange)
  // and tokens (.yes / .no). We read both and stash them on the pair.
  const market = (await sdk.markets.getMarket(pair.limitlessSlug)) as unknown as {
    tokens?: { yes?: string; no?: string };
    venue?: { exchange?: string };
    positionIds?: string[];
  };
  pair.yesToken = market.tokens?.yes ?? market.positionIds?.[0];
  pair.noToken = market.tokens?.no ?? market.positionIds?.[1];
  pair.exchangeAddress = market.venue?.exchange;

  if (!pair.yesToken || !pair.noToken) {
    throw new Error(`Limitless market ${pair.limitlessSlug} missing yes/no token ids`);
  }
  logger.info(
    {
      slug: pair.limitlessSlug,
      yes: pair.yesToken.slice(0, 8) + '…',
      exchange: pair.exchangeAddress,
    },
    'Limitless market resolved',
  );
}

export async function main(): Promise<void> {
  const settings = loadSettings();

  if (settings.dryRun) {
    logger.warn(
      '═══════════════ DRY_RUN MODE ═══════════════\n' +
        '  No orders signed or sent. Place/cancel/hedge → log-only.\n' +
        '  Polymarket auth probe is SKIPPED in dry-run.\n' +
        '  Unset DRY_RUN (or dry_run: false in yaml) to go live.\n' +
        '════════════════════════════════════════════',
    );
  }
  logger.info(
    {
      pairs: settings.pairs.length,
      orderSize: settings.orderSize,
      marginBps: settings.marginBps,
      hedgeThreshold: settings.hedgeThreshold,
      hedgeIntervalSec: settings.hedgeIntervalSec,
      dryRun: settings.dryRun,
    },
    'replicator boot',
  );

  // -- Limitless side --
  // Prefer scoped HMAC token; fall back to deprecated X-API-Key. The read
  // client (markets, portfolio) and the write client (orders) both need it.
  const limitlessAuth = settings.hmacCredentials
    ? { hmacCredentials: settings.hmacCredentials }
    : { apiKey: settings.lmtsApiKey };
  const http = new HttpClient(limitlessAuth);
  const sdk = Client.fromHttpClient(http);
  const trading = new SDKTradingClient({
    privateKey: settings.privateKey,
    ...limitlessAuth,
  });

  // -- Polymarket side --
  const poly = new PolymarketAdapter({
    privateKey: settings.privateKey,
    funder: settings.polyFunder,
    signatureType: settings.polySignatureType,
    dryRun: settings.dryRun,
  });

  // -- Auth probes (BEFORE any quoting starts) --
  // Limitless first-order will lazily fetch the profile; force it now so we
  // surface any 401 / wrong-API-key at boot, not on first fill.
  logger.info({ address: trading.getWalletAddress() }, 'Limitless trader');
  await poly.authProbe(); // throws actionable error on signatureType mismatch

  // -- Resolve market metadata for each pair --
  for (const pair of settings.pairs) {
    await resolveLimitlessMarket(sdk, pair);
    await poly.resolveAssetIds(pair);
  }

  // -- Shared state for WS → replicator --
  const feed = new QuoteFeed();
  const assetToSlug = new Map<string, string>();
  const yesAssets = new Set<string>();
  for (const pair of settings.pairs) {
    feed.ensureSlug(pair.polymarketSlug);
    if (!pair.polyYesAssetId || !pair.polyNoAssetId) {
      throw new Error(`pair ${pair.polymarketSlug} missing Polymarket asset ids after resolve`);
    }
    assetToSlug.set(pair.polyYesAssetId, pair.polymarketSlug);
    assetToSlug.set(pair.polyNoAssetId, pair.polymarketSlug);
    yesAssets.add(pair.polyYesAssetId);
  }

  // -- Spawn tasks under a shared AbortController --
  const ac = new AbortController();
  const tasks: Promise<void>[] = [
    runPolyWs(feed, assetToSlug, yesAssets, ac.signal),
    runHedger(settings.pairs, feed, sdk, poly, settings, ac.signal),
    ...settings.pairs.map((pair) =>
      runReplicator(pair, feed, trading, settings, ac.signal),
    ),
  ];

  // -- Wait for Ctrl-C / SIGTERM --
  const stop = new Promise<void>((resolve) => {
    const onSignal = () => {
      logger.info('shutdown signal received');
      ac.abort();
      resolve();
    };
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
  });

  logger.info('bot running. Ctrl-C to stop.');
  await stop;

  // Let all tasks settle their finally{} blocks (replicator cancelAll on shutdown)
  await Promise.allSettled(tasks);
  logger.info('bye.');
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('replicator failed to start:', err);
  process.exitCode = 1;
});
