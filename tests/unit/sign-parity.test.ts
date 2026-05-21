/**
 * SIGN PARITY CANARY — the load-bearing test for the SDK migration.
 *
 * Asserts that signing the same UnsignedOrder via:
 *   (a) the SDK's OrderSigner (ethers-based)
 *   (b) the hand-rolled OrderSigner in src/core/limitless/sign.ts (viem-based)
 * produces byte-identical EIP-712 signatures.
 *
 * If this passes, every existing strategy can swap to the SDK without any
 * change to its on-chain order semantics. If it fails — even by one byte —
 * the API will reject SDK-signed orders that previously worked, and
 * migration is unsafe without fixing the discrepancy first.
 *
 * Both libraries should produce identical signatures because:
 *   - EIP-712 typed-data hashing is fully specified (EIP-712 + EIP-191).
 *   - secp256k1 ECDSA with RFC 6979 deterministic nonce is what both libs use.
 *   - The Order struct + domain are character-identical between the two
 *     implementations (verified by reading both files).
 */

import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
import {
  createWalletClient,
  http as viemHttp,
  type WalletClient,
  type LocalAccount,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';

import { OrderSigner as SDKOrderSigner } from '@limitless-exchange/sdk';
import type {
  UnsignedOrder,
  OrderSigningConfig,
} from '@limitless-exchange/sdk';
import { OrderSigner as HandRolledOrderSigner } from '../../src/core/limitless/sign.js';

// A throwaway key generated for testing only. Has no funds, never will.
// (Hardhat account #1 — public, no risk.)
const TEST_PRIVATE_KEY =
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
// Address derived from the private key (instead of hardcoded — caught by SDK if mismatched).
const TEST_ADDRESS = new ethers.Wallet(TEST_PRIVATE_KEY).address;

// Realistic test exchange address (Base default CTF exchange).
const TEST_EXCHANGE = '0xa4409D988CA2218d956BeEFD3874100F444f0DC3';
const CHAIN_ID = 8453;

/** Build the same UnsignedOrder shape for both signers. */
function buildSampleOrder(): UnsignedOrder {
  return {
    salt: '12345678901234',
    maker: ethers.getAddress(TEST_ADDRESS),
    signer: ethers.getAddress(TEST_ADDRESS),
    taker: '0x0000000000000000000000000000000000000000',
    // Real-shaped Limitless tokenId (uint256, < 2^256). Just a non-trivial value.
    tokenId:
      '57896044618658097711785492504343953926634992332820282019728792003956564819968',
    makerAmount: '5000000', // $5
    takerAmount: '10000000', // 10 contracts
    expiration: '0',
    nonce: 0,
    feeRateBps: 300,
    side: 0, // BUY
    signatureType: 0, // EOA
  };
}

describe('Sign parity: SDK (ethers) vs hand-rolled (viem)', () => {
  it('produces byte-identical signatures for the same order', async () => {
    const order = buildSampleOrder();

    // --- SDK signer (ethers) ---
    const ethersWallet = new ethers.Wallet(TEST_PRIVATE_KEY);
    const sdkSigner = new SDKOrderSigner(ethersWallet);
    const sdkConfig: OrderSigningConfig = {
      chainId: CHAIN_ID,
      contractAddress: TEST_EXCHANGE,
    };
    const sdkSignature = await sdkSigner.signOrder(order, sdkConfig);

    // --- Hand-rolled signer (viem) ---
    const viemAccount: LocalAccount = privateKeyToAccount(TEST_PRIVATE_KEY);
    const viemWallet: WalletClient = createWalletClient({
      account: viemAccount,
      chain: base,
      transport: viemHttp(),
    });
    const handRolled = new HandRolledOrderSigner(
      viemWallet,
      viemAccount,
      CHAIN_ID
    );
    const handRolledSigned = await handRolled.signOrder(
      { exchange: TEST_EXCHANGE, type: 'standard' } as any,
      {
        tokenId: order.tokenId,
        makerAmount: BigInt(order.makerAmount),
        takerAmount: BigInt(order.takerAmount),
        side: 'BUY',
        expiration: Number(order.expiration),
        feeRateBps: order.feeRateBps,
        nonce: order.nonce,
      }
    );

    // The hand-rolled signer auto-generates salt (Date.now() based) — to make
    // the test deterministic, we sign a SECOND time with the SDK using the
    // salt the hand-rolled signer chose, and compare those two signatures.
    const orderWithMatchedSalt: UnsignedOrder = {
      ...order,
      salt: handRolledSigned.salt,
    };
    const sdkSignatureWithMatchedSalt = await sdkSigner.signOrder(
      orderWithMatchedSalt,
      sdkConfig
    );

    // The signatures must be byte-identical.
    expect(sdkSignatureWithMatchedSalt).toBe(handRolledSigned.signature);

    // Sanity: the original (different-salt) SDK signature must differ.
    expect(sdkSignature).not.toBe(handRolledSigned.signature);
  });

  it('signature recovers to the same wallet address (sanity)', async () => {
    const order = buildSampleOrder();

    const ethersWallet = new ethers.Wallet(TEST_PRIVATE_KEY);
    const sdkSigner = new SDKOrderSigner(ethersWallet);
    const signature = await sdkSigner.signOrder(order, {
      chainId: CHAIN_ID,
      contractAddress: TEST_EXCHANGE,
    });

    const domain = {
      name: 'Limitless CTF Exchange',
      version: '1',
      chainId: CHAIN_ID,
      verifyingContract: TEST_EXCHANGE,
    };
    const types = {
      Order: [
        { name: 'salt', type: 'uint256' },
        { name: 'maker', type: 'address' },
        { name: 'signer', type: 'address' },
        { name: 'taker', type: 'address' },
        { name: 'tokenId', type: 'uint256' },
        { name: 'makerAmount', type: 'uint256' },
        { name: 'takerAmount', type: 'uint256' },
        { name: 'expiration', type: 'uint256' },
        { name: 'nonce', type: 'uint256' },
        { name: 'feeRateBps', type: 'uint256' },
        { name: 'side', type: 'uint8' },
        { name: 'signatureType', type: 'uint8' },
      ],
    };
    const value = {
      salt: order.salt,
      maker: order.maker,
      signer: order.signer,
      taker: order.taker,
      tokenId: order.tokenId,
      makerAmount: order.makerAmount,
      takerAmount: order.takerAmount,
      expiration: order.expiration,
      nonce: order.nonce,
      feeRateBps: order.feeRateBps,
      side: order.side,
      signatureType: order.signatureType,
    };

    const recovered = ethers.verifyTypedData(domain, types, value, signature);
    expect(recovered.toLowerCase()).toBe(TEST_ADDRESS.toLowerCase());
  });
});
