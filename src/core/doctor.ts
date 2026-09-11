/**
 * doctor — preflight for any strategy in this repo. Answers "will my orders
 * be accepted?" before a single one is signed.
 *
 * Checks, in order:
 *   1. `PRIVATE_KEY` is present and well-formed (never printed).
 *   2. Limitless auth resolves (scoped HMAC token preferred; legacy key warns).
 *   3. `DRY_RUN` state, so a live flip is never a surprise.
 *   4. `GET /profiles/me` succeeds → the token works, and the profile's
 *      `account` matches the signing wallet (a token derived by another
 *      wallet makes every order fail "Signer does not match").
 *   5. Trading-wallet mode is `eoa`. The `smartWallet` trap: an account that
 *      once accepted the app's "choose your trading wallet" prompt rejects
 *      every self-signed order until switched back (`npm start wallet-mode eoa`).
 *   6. USDC + ETH balances on Base (USDC is collateral; ETH only pays gas for
 *      approvals and redemptions, orders themselves are off-chain).
 *   7. Optional: approvals for one market's exchange (+ adapter for neg-risk).
 *
 * Pure with respect to I/O: every network call goes through the injected
 * `sdk` / `publicClient`, so tests can drive it with fakes.
 */

import { createPublicClient, http, parseAbi, formatUnits, formatEther, getAddress, type Address, type PublicClient } from 'viem';
import { base } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { APIError, type Client } from '@limitless-exchange/sdk';
import { createSdkClient, hasAuth, isLegacyAuth, resolveAuth } from './limitless/client.js';
import { normalizeMarket } from './limitless/markets.js';

export const USDC_ADDRESS: Address = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
export const CTF_ADDRESS: Address = '0xC9c98965297Bc527861c898329Ee280632B76e18';

const ERC20_ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
]);
const CTF_ABI = parseAbi(['function isApprovedForAll(address owner, address operator) view returns (bool)']);

export interface DoctorCheck {
  name: string;
  ok: boolean;
  /** A failed critical check means orders will be rejected. */
  critical: boolean;
  detail?: string;
  fix?: string;
}

export interface DoctorReport {
  ok: boolean;
  wallet?: string;
  dryRun: boolean;
  checks: DoctorCheck[];
}

export interface DoctorOptions {
  env?: Record<string, string | undefined>;
  /** Also verify approvals for this market's venue. */
  marketSlug?: string;
  sdk?: Client;
  publicClient?: Pick<PublicClient, 'readContract' | 'getBalance'>;
}

/** Validate a private key without exposing it. */
export function isValidPrivateKey(key: string | undefined): key is `0x${string}` {
  if (!key) return false;
  const k = key.startsWith('0x') ? key : `0x${key}`;
  return /^0x[0-9a-fA-F]{64}$/.test(k);
}

export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  const env = options.env ?? process.env;
  const checks: DoctorCheck[] = [];
  const add = (c: DoctorCheck) => checks.push(c);
  const dryRun = env.DRY_RUN !== 'false';

  // 1. Private key
  let wallet: Address | undefined;
  if (isValidPrivateKey(env.PRIVATE_KEY)) {
    const key = env.PRIVATE_KEY.startsWith('0x') ? env.PRIVATE_KEY : `0x${env.PRIVATE_KEY}`;
    wallet = privateKeyToAccount(key as `0x${string}`).address;
    add({ name: 'PRIVATE_KEY', ok: true, critical: true, detail: `signs as ${wallet}` });
  } else {
    add({
      name: 'PRIVATE_KEY',
      ok: false,
      critical: true,
      detail: env.PRIVATE_KEY ? 'malformed (expected 0x + 64 hex chars)' : 'missing',
      fix: 'Put a dedicated trading wallet key in .env as PRIVATE_KEY (never your main wallet).',
    });
  }

  // 2. Auth
  const auth = resolveAuth({}, env);
  if (!hasAuth(auth)) {
    add({
      name: 'Limitless auth',
      ok: false,
      critical: true,
      detail: 'no LMTS_TOKEN_ID + LMTS_TOKEN_SECRET (or legacy LIMITLESS_API_KEY)',
      fix: 'limitless.exchange → connect wallet → API token modal → API Tokens → Derive; copy tokenId + secret into .env.',
    });
  } else if (isLegacyAuth(auth)) {
    add({
      name: 'Limitless auth',
      ok: true,
      critical: false,
      detail: 'legacy X-API-Key in use (deprecated, one key per account)',
      fix: 'Derive a scoped HMAC token and set LMTS_TOKEN_ID + LMTS_TOKEN_SECRET.',
    });
  } else {
    add({ name: 'Limitless auth', ok: true, critical: true, detail: 'scoped HMAC token' });
  }

  // 3. Dry run
  add({
    name: 'DRY_RUN',
    ok: true,
    critical: false,
    detail: dryRun ? 'true — orders are logged, nothing is signed' : 'false — LIVE, orders will be signed and sent',
  });

  // 4/5. Profile + wallet mode (needs auth)
  let sdk: Client | undefined = options.sdk;
  if (hasAuth(auth)) {
    sdk = sdk ?? createSdkClient({ ...auth, baseURL: env.LIMITLESS_API_URL });
    try {
      const profile = await sdk.portfolio.getProfile();
      add({ name: 'GET /profiles/me', ok: true, critical: true, detail: `profile #${profile.id} (${profile.account})` });

      if (wallet) {
        const same = safeEq(profile.account, wallet);
        add({
          name: 'Token wallet matches PRIVATE_KEY',
          ok: same,
          critical: true,
          detail: same ? 'match' : `token belongs to ${profile.account}, key signs as ${wallet}`,
          fix: same ? undefined : 'Derive the token while connected with the same wallet as PRIVATE_KEY, or change the key.',
        });
      }

      const mode = profile.tradeWalletOption;
      if (mode === 'eoa') {
        add({ name: 'Trading wallet mode', ok: true, critical: true, detail: 'eoa' });
      } else if (mode === 'smartWallet') {
        add({
          name: 'Trading wallet mode',
          ok: false,
          critical: true,
          detail: 'smartWallet — self-signed orders are rejected ("Signer does not match")',
          fix: 'Run: npm start wallet-mode eoa',
        });
      } else {
        add({ name: 'Trading wallet mode', ok: true, critical: false, detail: `unreported (${String(mode)}); assuming eoa` });
      }

      if (profile.rank?.feeRateBps !== undefined) {
        add({ name: 'Fee tier', ok: true, critical: false, detail: `${profile.rank.name ?? 'rank'} · feeRateBps ${profile.rank.feeRateBps}` });
      }
    } catch (err) {
      add({
        name: 'GET /profiles/me',
        ok: false,
        critical: true,
        detail: describeApiError(err),
        fix:
          err instanceof APIError && err.status === 401
            ? 'Check LMTS_TOKEN_SECRET is the base64 secret shown at derivation, and that the machine clock is accurate (HMAC has a short timestamp window).'
            : undefined,
      });
    }
  }

  // 6. Balances
  if (wallet) {
    const publicClient = options.publicClient ?? createPublicClient({ chain: base, transport: http() });
    try {
      const [usdc, eth] = await Promise.all([
        publicClient.readContract({ address: USDC_ADDRESS, abi: ERC20_ABI, functionName: 'balanceOf', args: [wallet] }),
        publicClient.getBalance({ address: wallet }),
      ]);
      const usdcHuman = Number(formatUnits(usdc, 6));
      add({
        name: 'USDC on Base',
        ok: usdc > 0n,
        critical: false,
        detail: `$${usdcHuman.toFixed(2)}`,
        fix: usdc > 0n ? undefined : 'Send USDC on Base to the wallet (collateral for orders).',
      });
      add({
        name: 'ETH on Base',
        ok: eth > 0n,
        critical: false,
        detail: `${Number(formatEther(eth)).toFixed(5)} ETH`,
        fix: eth > 0n ? undefined : 'A little ETH (~$1) pays gas for approvals and redemptions. Orders themselves are gasless.',
      });

      // 7. Market approvals
      if (options.marketSlug && sdk) {
        const market = normalizeMarket(await sdk.markets.getMarket(options.marketSlug));
        const exchange = market.venue?.exchange as Address | undefined;
        const adapter = (market.venue?.adapter ?? undefined) as Address | undefined;
        if (!exchange) {
          add({ name: `Venue for ${options.marketSlug}`, ok: false, critical: true, detail: 'market has no venue.exchange' });
        } else {
          const [allowance, ctfOk] = await Promise.all([
            publicClient.readContract({ address: USDC_ADDRESS, abi: ERC20_ABI, functionName: 'allowance', args: [wallet, exchange] }),
            publicClient.readContract({ address: CTF_ADDRESS, abi: CTF_ABI, functionName: 'isApprovedForAll', args: [wallet, exchange] }),
          ]);
          add({
            name: `USDC approved for exchange ${short(exchange)}`,
            ok: allowance > 0n,
            critical: true,
            detail: allowance > 0n ? 'ok (BUY orders)' : 'no allowance',
            fix: allowance > 0n ? undefined : `npm start approve ${options.marketSlug}`,
          });
          add({
            name: `CTF approved for exchange ${short(exchange)}`,
            ok: ctfOk,
            critical: false,
            detail: ctfOk ? 'ok (SELL orders)' : 'not approved — SELL orders will fail',
            fix: ctfOk ? undefined : `npm start approve ${options.marketSlug}`,
          });
          if (adapter) {
            const adapterOk = await publicClient.readContract({ address: CTF_ADDRESS, abi: CTF_ABI, functionName: 'isApprovedForAll', args: [wallet, adapter] });
            add({
              name: `CTF approved for neg-risk adapter ${short(adapter)}`,
              ok: adapterOk,
              critical: false,
              detail: adapterOk ? 'ok' : 'not approved — neg-risk SELL/redeem will fail',
              fix: adapterOk ? undefined : `npm start approve ${options.marketSlug}`,
            });
          }
        }
      }
    } catch (err) {
      add({ name: 'Base RPC', ok: false, critical: false, detail: (err as Error).message });
    }
  }

  return {
    ok: checks.every((c) => c.ok || !c.critical),
    wallet,
    dryRun,
    checks,
  };
}

/** Render a report for the terminal. */
export function formatDoctorReport(report: DoctorReport): string {
  const lines = report.checks.map((c) => {
    const mark = c.ok ? '✓' : c.critical ? '✗' : '!';
    const fix = !c.ok && c.fix ? `\n      → ${c.fix}` : '';
    return `  ${mark} ${c.name}${c.detail ? `: ${c.detail}` : ''}${fix}`;
  });
  const verdict = report.ok ? 'READY' : 'NOT READY — fix the ✗ items above';
  return [`Limitless doctor${report.wallet ? ` · ${report.wallet}` : ''}`, ...lines, '', `  ${verdict}`].join('\n');
}

function safeEq(a: string | undefined, b: string | undefined): boolean {
  try {
    return Boolean(a && b) && getAddress(a!) === getAddress(b!);
  } catch {
    return false;
  }
}

function short(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function describeApiError(err: unknown): string {
  if (err instanceof APIError) return `${err.status ?? ''} ${err.message}`.trim();
  return (err as Error)?.message ?? String(err);
}
