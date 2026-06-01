/**
 * Cross-market MM entry point — `npm run cross-market-mm`.
 *
 * Wires up:
 *   1. Loads .env + cross-market-mm.config.yaml.
 *   2. Constructs SDKTradingClient (Limitless side, EIP-712 signing).
 *   3. Constructs PolymarketAdapter (Polymarket side, FAK hedge).
 *   4. Runs both auth probes (Limitless login + Polymarket deriveApiKey)
 *      BEFORE quoting starts. Catches wrong signatureType / wrong funder
 *      in 2 seconds instead of after fills accumulate.
 *   5. Resolves market metadata on both venues for each pair.
 *   6. Spawns Poly WS task + N cross-market-mm tasks + 1 hedger task.
 *   7. Awaits SIGINT/SIGTERM, then cancels everything (cross-market-mm tasks
 *      cancel-all on the way out).
 */

import { pino } from 'pino';
import { Client, HttpClient } from '@limitless-exchange/sdk';
import { SDKTradingClient } from '../../core/limitless/sdk-trading.js';
import { LimitlessClient } from '../../core/limitless/markets.js';
import { PolymarketAdapter } from '../../core/polymarket/client.js';
import { runPolyWs } from '../../core/polymarket/ws.js';
import { QuoteFeed } from './quote-feed.js';
import { runReplicator } from './index.js';
import { runHedger } from './hedger.js';
import { flattenBothVenues } from './flatten-positions.js';
import { loadSettings } from './config.js';
import { Recorder } from './recorder.js';
import { RiskMonitor } from './risk.js';
import type { MarketPair } from './types.js';

const logger = pino({ level: process.env.LOG_LEVEL || 'info', name: 'cross-market-mm-main' });

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
    'cross-market-mm boot',
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
    dryRun: settings.dryRun, // single source of truth — env OR yaml, decided in config.ts
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

  // -- Boot clean: cancel any resting orders left by a prior run BEFORE
  //    quoting. This is the real guarantee against orphan accumulation — a
  //    shutdown can occasionally fail to cancel a just-placed order, but those
  //    age out and cancel cleanly here, so every run starts from a flat book.
  if (!settings.dryRun) {
    for (const pair of settings.pairs) {
      const res = await trading.cancelAllAndVerify(pair.limitlessSlug);
      logger.info({ slug: pair.limitlessSlug, remaining: res.remaining }, 'boot: book clean');
    }
  }

  // -- Shared state for WS → cross-market-mm --
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

  // -- Data capture: one JSONL file per run (orders, snapshots, hedges) --
  const recorder = new Recorder();
  recorder.record({
    kind: 'run',
    dryRun: settings.dryRun,
    pairs: settings.pairs.length,
    orderSize: settings.orderSize,
    marginBps: settings.marginBps,
  });
  logger.info({ file: recorder.filePath }, 'recording run data (npm run cross-market-mm:analyze)');

  // -- Loss circuit breaker (live only). Tripping aborts everything; the
  //    cross-market-mm tasks cancel-all in their finally{} on abort. --
  const ac = new AbortController();
  const risk = new RiskMonitor(settings.maxLossUsd);
  let killed = false;
  const onKill = () => {
    killed = true;
    ac.abort();
  };
  if (!settings.dryRun) {
    logger.warn({ maxLossUsd: settings.maxLossUsd }, 'circuit breaker armed (equity drawdown kill)');
  }

  // -- Spawn tasks under a shared AbortController --
  const tasks: Promise<void>[] = [
    runPolyWs(feed, assetToSlug, yesAssets, ac.signal),
    runHedger(settings.pairs, feed, sdk, poly, settings, ac.signal, {
      recorder,
      risk,
      walletAddress: trading.getWalletAddress(),
      onKill,
    }),
    ...settings.pairs.map((pair) =>
      runReplicator(pair, feed, trading, settings, ac.signal, recorder),
    ),
  ];

  // -- Wait for Ctrl-C / SIGTERM / circuit-breaker. Any abort (signal or
  //    onKill → ac.abort()) resolves this so we proceed to clean shutdown. --
  const stop = new Promise<void>((resolve) => {
    process.once('SIGINT', () => ac.abort());
    process.once('SIGTERM', () => ac.abort());
    ac.signal.addEventListener(
      'abort',
      () => {
        logger.info({ reason: killed ? 'circuit-breaker' : 'signal' }, 'shutting down');
        resolve();
      },
      { once: true },
    );
  });

  logger.info('bot running. Ctrl-C to stop.');
  await stop;

  // Let all tasks settle their finally{} blocks (cross-market-mm cancelAll on shutdown)
  await Promise.allSettled(tasks);

  // -- Flatten to flat on the way out (live only). Cancelling orders (above)
  //    stops new exposure, but a fill that already hedged leaves directional
  //    inventory on BOTH venues. flattenBothVenues sells/redeems it back to
  //    flat so a stop — Ctrl-C OR a tripped breaker — never walks away with an
  //    open position. Idempotent; re-run `npm run cross-market-mm:close` if a thin
  //    book leaves a remainder. --
  if (!settings.dryRun && settings.flattenOnStop) {
    logger.warn({ reason: killed ? 'circuit-breaker' : 'signal' }, 'flattening inventory on both venues');
    try {
      const md = new LimitlessClient();
      const results = await flattenBothVenues(trading, md, poly, settings.pairs);
      for (const r of results) {
        logger.info(
          {
            slug: r.slug,
            limitless: `YES ${r.limitless.yes.toFixed(2)} / NO ${r.limitless.no.toFixed(2)}`,
            polymarket: `YES ${r.polymarket.yes.toFixed(2)} / NO ${r.polymarket.no.toFixed(2)}`,
            flat: r.flat,
          },
          r.flat ? 'flat on both venues' : 'NOT fully flat — run `npm run cross-market-mm:close` to retry',
        );
      }
      if (results.some((r) => !r.flat)) {
        logger.error('some pairs left inventory (thin book?) — run `npm run cross-market-mm:close`');
      }
    } catch (e) {
      logger.error(
        { err: e instanceof Error ? e.message : e },
        'flatten-on-stop failed — run `npm run cross-market-mm:close` manually',
      );
    }
  }

  recorder.close();
  logger.info({ file: recorder.filePath }, 'run data saved');
  logger.info('bye.');
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('cross-market-mm failed to start:', err);
  process.exitCode = 1;
});
