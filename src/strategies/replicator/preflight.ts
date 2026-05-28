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
import { createPublicClient, http as viemHttp, parseAbi } from 'viem';
import { base, polygon } from 'viem/chains';
import { Client, HttpClient } from '@limitless-exchange/sdk';
import { SDKTradingClient } from '../../core/limitless/sdk-trading.js';
import { PolymarketAdapter } from '../../core/polymarket/client.js';
import { readBaseUsdc } from './risk.js';
import { loadSettings } from './config.js';

const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const ERC20_ALLOWANCE = parseAbi(['function allowance(address,address) view returns (uint256)']);
const SAFE_VERSION = parseAbi(['function VERSION() view returns (string)']);

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

  // -- Polymarket funder must be API-tradeable (deposit-wallet flow), NOT a
  //    Gnosis Safe. The CLOB rejects a Safe maker with "maker address not
  //    allowed, please use the deposit wallet flow" — auth + balance reads
  //    still work, so this only surfaces when an order is POSTed. Detect a
  //    Safe (it exposes VERSION()) up front and fail fast with the fix.
  try {
    const polyPub = createPublicClient({ chain: polygon, transport: viemHttp() });
    const ver = await polyPub
      .readContract({ address: s.polyFunder as `0x${string}`, abi: SAFE_VERSION, functionName: 'VERSION' })
      .catch(() => null);
    if (ver) {
      add(
        'Polymarket funder is API-tradeable',
        false,
        true,
        `funder is a Gnosis Safe (v${ver}) — Polymarket's CLOB will reject orders ` +
          `("use the deposit wallet flow"). Set poly_funder to your Polymarket ` +
          `deposit-wallet address (enable API trading in the Polymarket UI) and ` +
          `poly_signature_type: 3.`,
      );
    } else {
      add('Polymarket funder is API-tradeable', true, false, 'not a Gnosis Safe (deposit-wallet/EOA)');
    }
  } catch {
    /* RPC hiccup — non-critical, skip */
  }

  // -- Circuit breaker configured --
  add('Loss circuit-breaker', s.maxLossUsd > 0, true, `kill at -$${s.maxLossUsd}`);
  add('Order size sane', s.orderSize > 0 && s.orderSize <= 100, s.orderSize > 0, `${s.orderSize} contracts/side`);

  // -- Each pair resolves on both venues (+ collateral approved for its exchange) --
  const basePub = createPublicClient({ chain: base, transport: viemHttp() });
  for (const pair of s.pairs) {
    let exchange: string | undefined;
    try {
      const m = (await sdk.markets.getMarket(pair.limitlessSlug)) as unknown as {
        tokens?: { yes?: string; no?: string };
        positionIds?: string[];
        venue?: { exchange?: string };
      };
      const ok = !!(m.tokens?.yes ?? m.positionIds?.[0]);
      exchange = m.venue?.exchange;
      add(`Limitless market: ${pair.limitlessSlug.slice(0, 40)}`, ok, true, ok ? 'resolved' : 'no token ids');
    } catch (e) {
      add(`Limitless market: ${pair.limitlessSlug.slice(0, 40)}`, false, true, (e as Error).message);
    }
    // USDC must be approved for THIS market's exchange (neg-risk markets use a
    // separate exchange contract — a fresh approve is needed per exchange, or
    // quoting fails "Insufficient collateral allowance").
    if (exchange && address) {
      try {
        const allowance = (await basePub.readContract({
          address: BASE_USDC,
          abi: ERC20_ALLOWANCE,
          functionName: 'allowance',
          args: [address as `0x${string}`, exchange as `0x${string}`],
        })) as bigint;
        const ok = allowance > 0n;
        add(
          `Exchange approved: ${exchange.slice(0, 10)}…`,
          ok,
          true,
          ok ? 'USDC approved' : `not approved — run: npm start approve ${pair.limitlessSlug}`,
        );
      } catch {
        add(`Exchange approved: ${exchange.slice(0, 10)}…`, false, false, 'allowance read failed');
      }
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
