/**
 * preflight — validate everything the replicator needs BEFORE it quotes.
 *
 *   npm run replicator:preflight
 *
 * Read-only (plus a Polymarket API-key derive, which signs nothing on-chain).
 * Checks Limitless HMAC auth + collateral, Polymarket auth + sig type + pUSD,
 * the circuit-breaker setting, and that every configured pair resolves on both
 * venues. Prints a checklist and exits non-zero if any critical check fails,
 * so `npm run replicator:preflight && npm run replicator` is a safe gate.
 */

import 'dotenv/config';
import { Client, HttpClient } from '@limitless-exchange/sdk';
import { SDKTradingClient } from '../../core/limitless/sdk-trading.js';
import { PolymarketAdapter } from '../../core/polymarket/client.js';
import { readBaseUsdc } from './risk.js';
import { loadSettings } from './config.js';

interface Check {
  name: string;
  ok: boolean;
  critical: boolean;
  detail?: string;
}

async function main(): Promise<void> {
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, critical: boolean, detail?: string) =>
    checks.push({ name, ok, critical, detail });

  const s = loadSettings();
  const limitlessAuth = s.hmacCredentials
    ? { hmacCredentials: s.hmacCredentials }
    : { apiKey: s.lmtsApiKey };

  // -- Limitless HMAC auth (self-scoped read) --
  const http = new HttpClient(limitlessAuth);
  const sdk = Client.fromHttpClient(http);
  try {
    await sdk.portfolio.getCLOBPositions();
    add('Limitless auth (HMAC token)', true, true, s.hmacCredentials ? 'scoped token' : 'legacy api key');
  } catch (e) {
    add('Limitless auth (HMAC token)', false, true, (e as Error).message);
  }

  // -- Limitless trading wallet + Base USDC collateral --
  let address = '';
  try {
    const trading = new SDKTradingClient({ privateKey: s.privateKey, ...limitlessAuth });
    address = trading.getWalletAddress();
    add('Limitless trading wallet', true, true, address);
  } catch (e) {
    add('Limitless trading wallet', false, true, (e as Error).message);
  }
  if (address) {
    const usdc = await readBaseUsdc(address);
    add(
      'Base USDC (Limitless collateral)',
      usdc != null && usdc > 0,
      true,
      usdc == null ? 'read failed' : `$${usdc.toFixed(2)}`,
    );
  }

  // -- Polymarket auth + signature type --
  const poly = new PolymarketAdapter({
    privateKey: s.privateKey,
    funder: s.polyFunder,
    signatureType: s.polySignatureType,
    dryRun: false,
  });
  let polyOk = false;
  try {
    await poly.authProbe();
    polyOk = true;
    add(`Polymarket auth (sig type ${s.polySignatureType}, funder ${s.polyFunder.slice(0, 8)}…)`, true, true);
  } catch (e) {
    add('Polymarket auth', false, true, (e as Error).message);
  }
  if (polyOk) {
    const pusd = await poly.getCollateralBalance().catch(() => null);
    add(
      'Polymarket pUSD (hedge collateral)',
      pusd != null && pusd > 0,
      true,
      pusd == null ? 'read failed' : `$${pusd.toFixed(2)}`,
    );
  }

  // -- Circuit breaker configured --
  add('Loss circuit-breaker', s.maxLossUsd > 0, true, `kill at -$${s.maxLossUsd}`);
  add('Order size sane', s.orderSize > 0 && s.orderSize <= 100, s.orderSize > 0, `${s.orderSize} contracts/side`);

  // -- Each pair resolves on both venues --
  for (const pair of s.pairs) {
    try {
      const m = (await sdk.markets.getMarket(pair.limitlessSlug)) as unknown as {
        tokens?: { yes?: string; no?: string };
        positionIds?: string[];
      };
      const ok = !!(m.tokens?.yes ?? m.positionIds?.[0]);
      add(`Limitless market: ${pair.limitlessSlug.slice(0, 40)}`, ok, true, ok ? 'resolved' : 'no token ids');
    } catch (e) {
      add(`Limitless market: ${pair.limitlessSlug.slice(0, 40)}`, false, true, (e as Error).message);
    }
    try {
      await poly.resolveAssetIds(pair);
      add(`Polymarket market: ${pair.polymarketSlug.slice(0, 40)}`, true, true, 'resolved');
    } catch (e) {
      add(`Polymarket market: ${pair.polymarketSlug.slice(0, 40)}`, false, true, (e as Error).message);
    }
  }

  // -- Report --
  console.log('\n── Replicator preflight ──');
  for (const c of checks) {
    const mark = c.ok ? '✅' : c.critical ? '❌' : '⚠️ ';
    console.log(`${mark} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  }
  const failed = checks.filter((c) => !c.ok && c.critical);
  console.log('');
  if (failed.length > 0) {
    console.log(`FAILED: ${failed.length} critical check(s). Fix before running live.\n`);
    process.exit(1);
  }
  console.log(`All ${checks.length} checks passed. Safe to run (start with dry_run: true).\n`);
}

main().catch((e: unknown) => {
  console.error('preflight crashed:', e instanceof Error ? e.message : e);
  process.exit(1);
});
