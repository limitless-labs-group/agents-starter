/**
 * deposit — get the bridge address to fund your Polymarket deposit wallet.
 *
 *   npm run cross-market-mm:deposit
 *
 * The deposit wallet must hold pUSD, and you can't get pUSD there by sending
 * USDC to it directly. This prints the Polymarket bridge address: send USDC
 * (Base, Polygon, Ethereum, …) to it and it auto-wraps to pUSD and credits your
 * deposit wallet. Then confirm with `npm run cross-market-mm:status`.
 *
 * Read-only: allocates a deposit address, moves no funds.
 */

import 'dotenv/config';
import fs from 'node:fs';
import { readPolyFunder } from './init.js';
import { getDepositAddresses, getBaseUsdcMin } from './poly-bridge.js';

async function main(): Promise<void> {
  const yamlPath = process.env.CROSS_MARKET_MM_CONFIG_PATH || './cross-market-mm.config.yaml';
  const depositWallet = fs.existsSync(yamlPath)
    ? readPolyFunder(fs.readFileSync(yamlPath, 'utf-8'))
    : undefined;
  if (!depositWallet) {
    console.error(
      'poly_funder not set in the config — run `npm run cross-market-mm:setup-poly` (or :init) first.',
    );
    process.exit(1);
  }

  const [addrs, min] = await Promise.all([getDepositAddresses(depositWallet), getBaseUsdcMin()]);
  const minStr = min != null ? `min $${min}` : 'see /supported-assets for minimums';

  console.log('\nFund your Polymarket deposit wallet (USDC → pUSD, automatic):\n');
  console.log(`  1. Send USDC on Base  →  ${addrs.evm}`);
  console.log(`     (Polymarket bridge address, ${minStr}). Works from Polygon/Ethereum/other`);
  console.log(`     EVM chains too — same address. It wraps to pUSD and credits your wallet.`);
  console.log(`  2. pUSD lands in your deposit wallet:  ${depositWallet}`);
  console.log(`  3. Confirm:  npm run cross-market-mm:status   (pUSD should go up)`);
  console.log('\n  Send a small test first, confirm it lands, then send the rest.');
  console.log(`\n  ⚠ Do NOT send USDC straight to ${depositWallet} — only the bridge`);
  console.log(`    address above converts to spendable pUSD. The Polymarket APP's deposit`);
  console.log(`    button credits a DIFFERENT account, not this wallet.`);
  if (addrs.svm || addrs.tron || addrs.btc) {
    console.log(
      `\n  Non-EVM: ${[addrs.svm && `SOL ${addrs.svm}`, addrs.tron && `TRON ${addrs.tron}`, addrs.btc && `BTC ${addrs.btc}`].filter(Boolean).join('  ·  ')}`,
    );
  }
  console.log('');
}

main().catch((e: unknown) => {
  console.error('deposit failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});
