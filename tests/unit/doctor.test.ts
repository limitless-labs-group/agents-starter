/**
 * doctor with fakes: the smartWallet trap, wallet/token mismatch, missing
 * credentials, and the 401 hint. No network.
 */
import { describe, it, expect, vi } from 'vitest';
import { APIError, type Client } from '@limitless-exchange/sdk';
import { runDoctor, formatDoctorReport, isValidPrivateKey } from '../../src/core/doctor.js';

// Public Anvil test key (#1) — offline only.
const KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const ADDRESS = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

function fakeSdk(profile: unknown | Error, market?: unknown) {
  return {
    portfolio: { getProfile: vi.fn(profile instanceof Error ? () => Promise.reject(profile) : () => Promise.resolve(profile)) },
    markets: { getMarket: vi.fn().mockResolvedValue(market) },
  } as unknown as Client;
}

const chain = (usdc = 25_000_000n, eth = 10n ** 15n, allowance = 1n, approved = true) => ({
  readContract: vi.fn(async ({ functionName }: { functionName: string }) => {
    if (functionName === 'balanceOf') return usdc;
    if (functionName === 'allowance') return allowance;
    if (functionName === 'isApprovedForAll') return approved;
    return 0n;
  }),
  getBalance: vi.fn(async () => eth),
});

const env = { PRIVATE_KEY: KEY, LMTS_TOKEN_ID: 't', LMTS_TOKEN_SECRET: 'c2VjcmV0', DRY_RUN: 'true' };

describe('runDoctor', () => {
  it('passes a healthy eoa profile whose account matches the key', async () => {
    const report = await runDoctor({
      env,
      sdk: fakeSdk({ id: 1, account: ADDRESS, tradeWalletOption: 'eoa', rank: { name: 'Bronze', feeRateBps: 300 } }),
      publicClient: chain(),
    });
    expect(report.ok).toBe(true);
    expect(report.wallet).toBe(ADDRESS);
    expect(report.checks.find((c) => c.name === 'Trading wallet mode')?.ok).toBe(true);
    expect(formatDoctorReport(report)).toContain('READY');
  });

  it('flags the smartWallet trap as critical with the wallet-mode fix', async () => {
    const report = await runDoctor({
      env,
      sdk: fakeSdk({ id: 1, account: ADDRESS, tradeWalletOption: 'smartWallet' }),
      publicClient: chain(),
    });
    expect(report.ok).toBe(false);
    const c = report.checks.find((x) => x.name === 'Trading wallet mode')!;
    expect(c.ok).toBe(false);
    expect(c.critical).toBe(true);
    expect(c.fix).toMatch(/wallet-mode eoa/);
  });

  it('flags a token that belongs to a different wallet than PRIVATE_KEY', async () => {
    const report = await runDoctor({
      env,
      sdk: fakeSdk({ id: 1, account: '0x000000000000000000000000000000000000dEaD', tradeWalletOption: 'eoa' }),
      publicClient: chain(),
    });
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.name === 'Token wallet matches PRIVATE_KEY')?.ok).toBe(false);
  });

  it('gives the clock/secret hint on a 401 from /profiles/me', async () => {
    const report = await runDoctor({ env, sdk: fakeSdk(new APIError('Invalid HMAC authentication', 401)), publicClient: chain() });
    const c = report.checks.find((x) => x.name === 'GET /profiles/me')!;
    expect(c.ok).toBe(false);
    expect(c.fix).toMatch(/clock/i);
  });

  it('reports missing key and auth without touching the network', async () => {
    const report = await runDoctor({ env: {}, publicClient: chain() });
    expect(report.ok).toBe(false);
    expect(report.checks.map((c) => c.name)).toEqual(['PRIVATE_KEY', 'Limitless auth', 'DRY_RUN']);
  });

  it('treats a legacy API key as a non-critical warning', async () => {
    const report = await runDoctor({
      env: { PRIVATE_KEY: KEY, LIMITLESS_API_KEY: 'legacy' },
      sdk: fakeSdk({ id: 1, account: ADDRESS, tradeWalletOption: 'eoa' }),
      publicClient: chain(),
    });
    const c = report.checks.find((x) => x.name === 'Limitless auth')!;
    expect(c.ok).toBe(true);
    expect(c.critical).toBe(false);
    expect(c.detail).toMatch(/legacy/);
  });

  it('checks approvals for a market when asked, including the neg-risk adapter', async () => {
    const report = await runDoctor({
      env,
      marketSlug: 'grp-child',
      sdk: fakeSdk({ id: 1, account: ADDRESS, tradeWalletOption: 'eoa' }, { slug: 'grp-child', venue: { exchange: '0x1111111111111111111111111111111111111111', adapter: '0x2222222222222222222222222222222222222222' } }),
      publicClient: chain(1n, 1n, 0n, false),
    });
    const names = report.checks.map((c) => c.name);
    expect(names.some((n) => n.startsWith('USDC approved for exchange'))).toBe(true);
    expect(names.some((n) => n.startsWith('CTF approved for neg-risk adapter'))).toBe(true);
    expect(report.ok).toBe(false); // no USDC allowance is critical
    expect(report.checks.find((c) => c.name.startsWith('USDC approved'))?.fix).toMatch(/approve grp-child/);
  });
});

describe('isValidPrivateKey', () => {
  it('accepts 0x-prefixed and bare 64-hex keys, rejects the rest', () => {
    expect(isValidPrivateKey(KEY)).toBe(true);
    expect(isValidPrivateKey(KEY.slice(2))).toBe(true);
    expect(isValidPrivateKey('0x123')).toBe(false);
    expect(isValidPrivateKey(undefined)).toBe(false);
  });
});
