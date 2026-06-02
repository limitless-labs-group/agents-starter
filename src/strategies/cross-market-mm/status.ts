/**
 * status — one cross-venue portfolio view.
 *
 *   npm run cross-market-mm:status            # human-readable
 *   npm run cross-market-mm:status -- --json  # machine-readable (for an orchestrator)
 *
 * Read-only. Shows your Limitless balance + positions/orders, and your
 * Polymarket DEPOSIT WALLET's pUSD + positions. The deposit wallet is a
 * separate address from your Polymarket UI login, so it does NOT appear in the
 * Polymarket UI — this command (and the printed on-chain links) is how you see
 * those funds and positions.
 *
 * This is a fresh, independent read from the venues — distinct from the live
 * `data/cross-market-mm-status.json` a running bot maintains. Use `--json` when
 * an agent needs to double-check current state from scratch.
 */

import 'dotenv/config';
import { createPublicClient, http, parseAbi } from 'viem';
import { polygon } from 'viem/chains';
import { SDKTradingClient } from '../../core/limitless/sdk-trading.js';
import { PolymarketAdapter } from '../../core/polymarket/client.js';
import { readBaseUsdc } from './risk.js';
import { loadSettings } from './config.js';

const PUSD = '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB';
const ERC20 = parseAbi(['function balanceOf(address) view returns (uint256)']);

interface StatusReport {
  eoa: string;
  limitless: {
    usdc: number | null;
    pairs: Array<{ slug: string; yes: number; no: number; liveOrders: number }>;
  };
  polymarket: {
    depositWallet: string;
    pusd: number | null;
    positions: Array<{ slug: string; yes: number; no: number }>;
  } | null;
  netDelta: Array<{ slug: string; net: number; flat: boolean }>;
}

async function main(): Promise<void> {
  const asJson = process.argv.includes('--json');
  const s = loadSettings();
  const auth = s.hmacCredentials ? { hmacCredentials: s.hmacCredentials } : { apiKey: s.lmtsApiKey };
  const trading = new SDKTradingClient({ privateKey: s.privateKey, ...auth, dryRun: true });
  const eoa = trading.getWalletAddress();

  // ── Collect: Limitless (Base) ──
  const usdc = await readBaseUsdc(eoa);
  const lmtsPairs: StatusReport['limitless']['pairs'] = [];
  for (const pair of s.pairs) {
    const { yes, no } = await trading.getPositionTokens(pair.limitlessSlug).catch(() => ({ yes: 0, no: 0 }));
    const liveOrders = await trading.countLiveOrders(pair.limitlessSlug).catch(() => 0);
    lmtsPairs.push({ slug: pair.limitlessSlug, yes, no, liveOrders });
  }

  // ── Collect: Polymarket (deposit wallet) + cross-venue net delta ──
  const dw = s.polyFunder;
  let polymarket: StatusReport['polymarket'] = null;
  const netDelta: StatusReport['netDelta'] = [];
  if (dw) {
    const pub = createPublicClient({ chain: polygon, transport: http() });
    const pusdRaw = await pub
      .readContract({ address: PUSD, abi: ERC20, functionName: 'balanceOf', args: [dw as `0x${string}`] })
      .catch(() => null);
    const pusd = pusdRaw == null ? null : Number(pusdRaw) / 1e6;
    const poly = new PolymarketAdapter({ privateKey: s.privateKey, funder: dw, signatureType: s.polySignatureType, dryRun: true });
    for (const pair of s.pairs) await poly.resolveAssetIds(pair).catch(() => {});
    const positions = await poly.getPositions(s.pairs);
    polymarket = {
      depositWallet: dw,
      pusd,
      positions: [...positions.entries()].map(([slug, pos]) => ({ slug, yes: pos.yes, no: pos.no })),
    };
    for (const pair of s.pairs) {
      const l = await trading.getPositionTokens(pair.limitlessSlug).catch(() => ({ yes: 0, no: 0 }));
      const p = positions.get(pair.polymarketSlug) ?? { yes: 0, no: 0 };
      // Long YES on Limitless is hedged by long NO on Poly (and vice-versa).
      const net = l.yes - l.no - (p.no - p.yes);
      netDelta.push({ slug: pair.polymarketSlug, net, flat: Math.abs(net) < 0.5 });
    }
  }

  if (asJson) {
    const report: StatusReport = { eoa, limitless: { usdc, pairs: lmtsPairs }, polymarket, netDelta };
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  // ── Render: human-readable ──
  console.log('\n═══ Limitless (Base) ═══');
  console.log(`  signer/wallet: ${eoa}`);
  console.log(`  USDC (collateral): ${usdc == null ? 'read failed' : '$' + usdc.toFixed(2)}`);
  for (const p of lmtsPairs) {
    console.log(`  ${p.slug}: YES ${p.yes.toFixed(2)} / NO ${p.no.toFixed(2)} | live orders ${p.liveOrders}`);
  }

  console.log('\n═══ Polymarket (deposit wallet) ═══');
  if (!polymarket) {
    console.log('  poly_funder not set — run `npm run cross-market-mm:setup-poly` and set poly_funder + poly_signature_type: 3.');
  } else {
    console.log(`  deposit wallet: ${polymarket.depositWallet}`);
    console.log(`  view: https://polygonscan.com/address/${polymarket.depositWallet}`);
    console.log(`        https://data-api.polymarket.com/positions?user=${polymarket.depositWallet}`);
    console.log(`  pUSD (hedge collateral): ${polymarket.pusd == null ? 'read failed' : '$' + polymarket.pusd.toFixed(2)}`);
    if (polymarket.positions.length === 0) console.log('  positions: none');
    for (const pos of polymarket.positions) console.log(`  ${pos.slug}: YES ${pos.yes.toFixed(2)} / NO ${pos.no.toFixed(2)}`);

    console.log('\n═══ Cross-venue net delta (≈0 = hedged) ═══');
    for (const d of netDelta) {
      console.log(`  ${d.slug}: net ${d.net.toFixed(2)} ${d.flat ? '(flat)' : '(UNHEDGED)'}`);
    }
  }
  console.log('');
}

main().catch((e: unknown) => {
  console.error('status failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});
