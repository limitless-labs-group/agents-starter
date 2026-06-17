/**
 * init — guided, re-runnable bootstrap for cross-market-mm.
 *
 *   npm run cross-market-mm:init
 *
 * Walks the dependency-ordered setup and advances as far as it can each run,
 * then tells you the one thing to do before running it again:
 *
 *   A. scaffold  — create .env + the config yaml from the templates
 *   B. creds     — check PRIVATE_KEY + Limitless token + relayer key are set
 *                  (you fill .env yourself; this never reads or prints secrets)
 *   C. deposit   — derive + deploy the Polymarket deposit wallet, and write its
 *                  address into the config for you (no copy-paste)
 *   D. funding   — read both balances and print the exact addresses to fund
 *
 * It is idempotent: run it, do the step it asks for, run it again. Secrets are
 * the human's job — init guides and validates, but you place the private key
 * and tokens in .env in your own editor. init never echoes them.
 */

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, http, parseAbi } from 'viem';
import { polygon } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { readBaseUsdc } from './risk.js';
import { setupDepositWallet } from './setup-poly-wallet.js';
import { getDepositAddresses } from './poly-bridge.js';

const PUSD = '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB';
const ERC20 = parseAbi(['function balanceOf(address) view returns (uint256)']);

// ── Pure helpers (unit-tested) ────────────────────────────────────────────

/** A value is "real" if it's set and isn't one of the .env.example placeholders. */
export function looksReal(v?: string): boolean {
  if (!v) return false;
  const t = v.trim();
  if (t.length < 4) return false;
  if (t.includes('your-')) return false; // e.g. your-token-id
  if (/\.\.\./.test(t)) return false; // e.g. 0x...
  return true;
}

export function isValidPrivateKey(v?: string): boolean {
  return !!v && /^(0x)?[0-9a-fA-F]{64}$/.test(v.trim());
}

export function isAddress(v?: string): boolean {
  return !!v && /^0x[0-9a-fA-F]{40}$/.test(v.trim());
}

export interface CredEnv {
  PRIVATE_KEY?: string;
  LMTS_TOKEN_ID?: string;
  LMTS_TOKEN_SECRET?: string;
  LIMITLESS_API_KEY?: string;
  RELAYER_API_KEY?: string;
  RELAYER_API_KEY_ADDRESS?: string;
}

/** Names of the credentials that are still missing or placeholder. */
export function missingCredentials(env: CredEnv): string[] {
  const missing: string[] = [];
  if (!isValidPrivateKey(env.PRIVATE_KEY)) missing.push('PRIVATE_KEY');
  const hasHmac = looksReal(env.LMTS_TOKEN_ID) && looksReal(env.LMTS_TOKEN_SECRET);
  const hasLegacy = looksReal(env.LIMITLESS_API_KEY);
  if (!hasHmac && !hasLegacy) missing.push('LMTS_TOKEN_ID + LMTS_TOKEN_SECRET');
  if (!looksReal(env.RELAYER_API_KEY)) missing.push('RELAYER_API_KEY');
  if (!isAddress(env.RELAYER_API_KEY_ADDRESS)) missing.push('RELAYER_API_KEY_ADDRESS');
  return missing;
}

/** Surgically set poly_funder + poly_signature_type in the yaml, preserving comments. */
export function setPolyFunderInYaml(yamlText: string, address: string): string {
  let out = yamlText;
  if (/^\s*poly_funder:.*$/m.test(out)) {
    out = out.replace(/^(\s*)poly_funder:.*$/m, `$1poly_funder: "${address}"`);
  } else {
    out += `\npoly_funder: "${address}"\n`;
  }
  if (/^\s*poly_signature_type:.*$/m.test(out)) {
    out = out.replace(/^(\s*)poly_signature_type:.*$/m, `$1poly_signature_type: 3`);
  } else {
    out += `poly_signature_type: 3\n`;
  }
  return out;
}

/** Read the configured poly_funder value out of yaml text (undefined if unset). */
export function readPolyFunder(yamlText: string): string | undefined {
  const m = yamlText.match(/^\s*poly_funder:\s*["']?([^"'\s#]+)/m);
  const v = m?.[1];
  return v && isAddress(v) ? v : undefined;
}

// ── Side-effecting bits ────────────────────────────────────────────────────

const normalizePk = (pk: string): `0x${string}` =>
  (pk.startsWith('0x') ? pk : `0x${pk}`) as `0x${string}`;

async function readPusd(addr: string): Promise<number> {
  try {
    const pub = createPublicClient({ chain: polygon, transport: http() });
    const bal = (await pub.readContract({
      address: PUSD,
      abi: ERC20,
      functionName: 'balanceOf',
      args: [addr as `0x${string}`],
    })) as bigint;
    return Number(bal) / 1e6;
  } catch {
    return 0;
  }
}

function ensureFile(target: string, source: string): boolean {
  if (fs.existsSync(target)) return false;
  fs.copyFileSync(source, target);
  return true;
}

function printCredentialGuide(missing: string[]): void {
  console.log('\nFill these in .env (open it in your editor — never paste secrets in a chat):\n');
  if (missing.includes('PRIVATE_KEY')) {
    console.log('• PRIVATE_KEY — a DEDICATED trading wallet, never your main one.');
    console.log('    Create a fresh EOA in a wallet app (MetaMask/Rabby), export its');
    console.log('    private key, paste as  PRIVATE_KEY=0x...');
  }
  if (missing.some((m) => m.startsWith('LMTS_TOKEN_ID'))) {
    console.log('• LMTS_TOKEN_ID + LMTS_TOKEN_SECRET — Limitless scoped HMAC token.');
    console.log('    limitless.exchange → connect the same wallet → API token modal →');
    console.log('    "API Tokens" tab → Derive → copy tokenId + secret.');
  }
  if (missing.includes('RELAYER_API_KEY') || missing.includes('RELAYER_API_KEY_ADDRESS')) {
    console.log('• RELAYER_API_KEY + RELAYER_API_KEY_ADDRESS — Polymarket relayer key.');
    console.log('    Polymarket builder API Keys page (docs.polymarket.com/builders/api-keys)');
    console.log('    → create a relayer API key. RELAYER_API_KEY_ADDRESS is your EOA');
    console.log('    public address (the same wallet as PRIVATE_KEY). Used once, for the');
    console.log('    deposit-wallet setup only.');
  }
  console.log('\nThen run  npm run cross-market-mm:init  again.');
}

async function main(): Promise<void> {
  console.log('cross-market-mm init — guided setup\n');

  // ── Phase A: scaffold ──
  const here = path.dirname(fileURLToPath(import.meta.url));
  const envCreated = ensureFile('.env', '.env.example');
  if (envCreated) fs.chmodSync('.env', 0o600);
  const yamlPath = process.env.CROSS_MARKET_MM_CONFIG_PATH || './cross-market-mm.config.yaml';
  const yamlCreated = ensureFile(yamlPath, path.join(here, 'config.example.yaml'));
  if (yamlCreated) console.log(`✓ created ${yamlPath} (from the template)`);

  if (envCreated) {
    console.log('✓ created .env (chmod 600) from .env.example');
    printCredentialGuide(['PRIVATE_KEY', 'LMTS_TOKEN_ID', 'RELAYER_API_KEY', 'RELAYER_API_KEY_ADDRESS']);
    return;
  }

  // ── Phase B: credentials ──
  const missing = missingCredentials(process.env);
  if (missing.length > 0) {
    console.log(`Credentials still needed: ${missing.join(', ')}`);
    printCredentialGuide(missing);
    return;
  }
  console.log('✓ credentials look set (PRIVATE_KEY, Limitless token, relayer key)');

  // ── Phase C: deposit wallet ──
  let yamlText = fs.readFileSync(yamlPath, 'utf-8');
  let depositWallet = readPolyFunder(yamlText);
  if (!depositWallet) {
    console.log('\nDeriving + deploying your Polymarket deposit wallet (gasless)…');
    const res = await setupDepositWallet();
    depositWallet = res.depositWallet;
    yamlText = setPolyFunderInYaml(yamlText, depositWallet);
    fs.writeFileSync(yamlPath, yamlText);
    console.log(`✓ wrote poly_funder ${depositWallet} into ${yamlPath}`);
  } else {
    console.log(`✓ deposit wallet already configured: ${depositWallet}`);
  }

  // ── Phase D: funding ──
  const eoa = privateKeyToAccount(normalizePk(process.env.PRIVATE_KEY as string)).address;
  const [baseUsdc, pusd] = await Promise.all([readBaseUsdc(eoa), readPusd(depositWallet)]);
  const fmt = (n: number | null): string => (n == null ? 'read failed' : `$${n.toFixed(2)}`);

  // The hedge side needs pUSD IN the deposit wallet — and you can't get it there
  // by sending USDC to the wallet directly. Pull the Polymarket bridge address
  // so we can tell the user exactly where to send USDC (it auto-wraps to pUSD).
  let bridgeEvm: string | null = null;
  try {
    bridgeEvm = (await getDepositAddresses(depositWallet)).evm;
  } catch {
    /* non-fatal — fall back to a pointer at the deposit command */
  }

  console.log('\nFund both sides:');
  console.log(`  • Base collateral → your EOA  ${eoa}`);
  console.log(`      USDC ${fmt(baseUsdc)}  + a little ETH for gas. (send USDC here directly)`);
  console.log(`  • Polygon hedge → pUSD in the deposit wallet  ${depositWallet}  (now ${fmt(pusd)})`);
  if (bridgeEvm) {
    console.log(`      Get pUSD there by sending USDC on Base to the bridge address:`);
    console.log(`        ${bridgeEvm}`);
    console.log(`      It auto-wraps to pUSD and credits the deposit wallet. Do NOT send`);
    console.log(`      USDC straight to ${depositWallet} (not buying power), and the`);
    console.log(`      Polymarket app's deposit button credits a different account.`);
  } else {
    console.log(`      To fund it: npm run cross-market-mm:deposit  (prints the bridge address)`);
  }

  const fundedBase = (baseUsdc ?? 0) > 0;
  const fundedPoly = pusd > 0;
  if (fundedBase && fundedPoly) {
    console.log('\n✓ Funded on both sides. Next:');
    console.log('  npm run cross-market-mm:find-pairs   # pick a pair, verify identical resolution');
    console.log('  npm run cross-market-mm:preflight    # then dry run, then go live');
  } else {
    console.log('\nFund the side(s) above, then run init again. (Send a small test first.)');
  }
}

// Run as a CLI only when invoked directly.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e: unknown) => {
    console.error('init failed:', e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
