/**
 * status — one cross-venue portfolio view.
 *
 *   npm run replicator:status
 *
 * Read-only. Shows your Limitless balance + positions/orders, and your
 * Polymarket DEPOSIT WALLET's pUSD + positions. The deposit wallet is a
 * separate address from your Polymarket UI login, so it does NOT appear in the
 * Polymarket UI — this command (and the printed on-chain links) is how you see
 * those funds and positions.
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

async function main(): Promise<void> {
  const s = loadSettings();
  const auth = s.hmacCredentials ? { hmacCredentials: s.hmacCredentials } : { apiKey: s.lmtsApiKey };
  const trading = new SDKTradingClient({ privateKey: s.privateKey, ...auth, dryRun: true });
  const eoa = trading.getWalletAddress();

  // ── Limitless (Base) ──
  console.log('\n═══ Limitless (Base) ═══');
  console.log(`  signer/wallet: ${eoa}`);
  const usdc = await readBaseUsdc(eoa);
  console.log(`  USDC (collateral): ${usdc == null ? 'read failed' : '$' + usdc.toFixed(2)}`);
  for (const pair of s.pairs) {
    const { yes, no } = await trading.getPositionTokens(pair.limitlessSlug).catch(() => ({ yes: 0, no: 0 }));
    const live = await trading.countLiveOrders(pair.limitlessSlug).catch(() => 0);
    console.log(`  ${pair.limitlessSlug}: YES ${yes.toFixed(2)} / NO ${no.toFixed(2)} | live orders ${live}`);
  }

  // ── Polymarket (deposit wallet) ──
  console.log('\n═══ Polymarket (deposit wallet) ═══');
  const dw = s.polyFunder;
  if (!dw) {
    console.log('  poly_funder not set — run `npm run replicator:setup-poly` and set poly_funder + poly_signature_type: 3.');
  } else {
    console.log(`  deposit wallet: ${dw}`);
    console.log(`  view: https://polygonscan.com/address/${dw}`);
    console.log(`        https://data-api.polymarket.com/positions?user=${dw}`);
    const pub = createPublicClient({ chain: polygon, transport: http() });
    const pusd = await pub
      .readContract({ address: PUSD, abi: ERC20, functionName: 'balanceOf', args: [dw as `0x${string}`] })
      .catch(() => null);
    console.log(`  pUSD (hedge collateral): ${pusd == null ? 'read failed' : '$' + (Number(pusd) / 1e6).toFixed(2)}`);
    const poly = new PolymarketAdapter({ privateKey: s.privateKey, funder: dw, signatureType: s.polySignatureType, dryRun: true });
    for (const pair of s.pairs) await poly.resolveAssetIds(pair).catch(() => {});
    const positions = await poly.getPositions(s.pairs);
    if (positions.size === 0) console.log('  positions: none');
    for (const [slug, pos] of positions) console.log(`  ${slug}: YES ${pos.yes.toFixed(2)} / NO ${pos.no.toFixed(2)}`);

    // ── Cross-venue net delta per pair (Limitless YES−NO  vs  Poly NO−YES) ──
    console.log('\n═══ Cross-venue net delta (≈0 = hedged) ═══');
    for (const pair of s.pairs) {
      const l = await trading.getPositionTokens(pair.limitlessSlug).catch(() => ({ yes: 0, no: 0 }));
      const p = positions.get(pair.polymarketSlug) ?? { yes: 0, no: 0 };
      // Long YES on Limitless is hedged by long NO on Poly (and vice-versa).
      const net = l.yes - l.no - (p.no - p.yes);
      console.log(`  ${pair.polymarketSlug}: net ${net.toFixed(2)} ${Math.abs(net) < 0.5 ? '(flat)' : '(UNHEDGED)'}`);
    }
  }
  console.log('');
}

main().catch((e: unknown) => {
  console.error('status failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});
