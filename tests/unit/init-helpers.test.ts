/**
 * init pure helpers — credential validation + surgical yaml writes.
 */

import { describe, expect, it } from 'vitest';
import {
  looksReal,
  isValidPrivateKey,
  isAddress,
  missingCredentials,
  setPolyFunderInYaml,
  readPolyFunder,
} from '../../src/strategies/cross-market-mm/init.js';

const REAL_PK = '0x' + 'a'.repeat(64);
const REAL_ADDR = '0x' + 'b'.repeat(40);

describe('looksReal', () => {
  it('rejects placeholders and empties', () => {
    expect(looksReal('your-token-id')).toBe(false);
    expect(looksReal('0x...')).toBe(false);
    expect(looksReal('')).toBe(false);
    expect(looksReal(undefined)).toBe(false);
  });
  it('accepts a real value', () => {
    expect(looksReal('abc123def456')).toBe(true);
  });
});

describe('isValidPrivateKey / isAddress', () => {
  it('validates a 64-hex key with or without 0x', () => {
    expect(isValidPrivateKey(REAL_PK)).toBe(true);
    expect(isValidPrivateKey('a'.repeat(64))).toBe(true);
    expect(isValidPrivateKey('0x...your-wallet-private-key')).toBe(false);
    expect(isValidPrivateKey('0xabc')).toBe(false);
  });
  it('validates a 40-hex address', () => {
    expect(isAddress(REAL_ADDR)).toBe(true);
    expect(isAddress('0xyour-signer-eoa-address')).toBe(false);
  });
});

describe('missingCredentials', () => {
  it('lists everything for a fresh placeholder env', () => {
    const m = missingCredentials({
      PRIVATE_KEY: '0x...your-wallet-private-key',
      LMTS_TOKEN_ID: 'your-token-id',
      LMTS_TOKEN_SECRET: 'your-base64-token-secret',
      RELAYER_API_KEY: 'your-relayer-api-key',
      RELAYER_API_KEY_ADDRESS: '0xyour-signer-eoa-address',
    });
    expect(m).toContain('PRIVATE_KEY');
    expect(m).toContain('LMTS_TOKEN_ID + LMTS_TOKEN_SECRET');
    expect(m).toContain('RELAYER_API_KEY');
    expect(m).toContain('RELAYER_API_KEY_ADDRESS');
  });
  it('is empty when all real (HMAC path)', () => {
    expect(
      missingCredentials({
        PRIVATE_KEY: REAL_PK,
        LMTS_TOKEN_ID: 'tok_abc',
        LMTS_TOKEN_SECRET: 'c2VjcmV0',
        RELAYER_API_KEY: 'relayer_abc',
        RELAYER_API_KEY_ADDRESS: REAL_ADDR,
      }),
    ).toEqual([]);
  });
  it('accepts the legacy api key instead of an HMAC token', () => {
    const m = missingCredentials({
      PRIVATE_KEY: REAL_PK,
      LIMITLESS_API_KEY: 'legacy_key_value',
      RELAYER_API_KEY: 'relayer_abc',
      RELAYER_API_KEY_ADDRESS: REAL_ADDR,
    });
    expect(m).toEqual([]);
  });
});

describe('setPolyFunderInYaml / readPolyFunder', () => {
  const yaml = [
    '# comment stays',
    'poly_funder: "0xYourPolymarketFunderAddress"',
    'poly_signature_type: 3',
    'order_size: 5  # keep this',
  ].join('\n');

  it('writes the address and preserves comments', () => {
    const out = setPolyFunderInYaml(yaml, REAL_ADDR);
    expect(out).toContain(`poly_funder: "${REAL_ADDR}"`);
    expect(out).toContain('# comment stays');
    expect(out).toContain('order_size: 5  # keep this');
    expect(out).not.toContain('0xYourPolymarketFunderAddress');
  });

  it('round-trips through readPolyFunder', () => {
    expect(readPolyFunder(yaml)).toBeUndefined(); // placeholder isn't a valid address
    const out = setPolyFunderInYaml(yaml, REAL_ADDR);
    expect(readPolyFunder(out)).toBe(REAL_ADDR);
  });
});
