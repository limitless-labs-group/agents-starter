/**
 * SIGNING CANARY — proves the SDK signs the EIP-712 Order struct that the
 * Limitless docs specify, byte-for-byte.
 *
 * The repo no longer carries its own signer; the SDK's `OrderSigner` is the
 * only path. This test re-derives the signature independently with viem from
 * the documented domain + struct and asserts equality. If it ever fails, the
 * SDK changed what it signs and orders will be rejected as "Invalid signature".
 *
 * @see https://docs.limitless.exchange/developers/eip712-signing
 */

import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
import { privateKeyToAccount } from 'viem/accounts';
import { OrderSigner, type OrderSigningConfig, type UnsignedOrder } from '@limitless-exchange/sdk';

// Public Anvil/Hardhat account #1 key — never funded.
const TEST_PRIVATE_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const TEST_ADDRESS = new ethers.Wallet(TEST_PRIVATE_KEY).address;
const TEST_EXCHANGE = '0xa4409D988CA2218d956BeEFD3874100F444f0DC3';
const CHAIN_ID = 8453;

/** The documented EIP-712 domain: name/version fixed, verifyingContract = market venue exchange. */
const domain = {
  name: 'Limitless CTF Exchange',
  version: '1',
  chainId: CHAIN_ID,
  verifyingContract: TEST_EXCHANGE as `0x${string}`,
} as const;

/** The documented Order struct, field order included. */
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
} as const;

function sampleOrder(): UnsignedOrder {
  return {
    salt: 12345678901234,
    maker: ethers.getAddress(TEST_ADDRESS),
    signer: ethers.getAddress(TEST_ADDRESS),
    taker: '0x0000000000000000000000000000000000000000',
    tokenId: '57896044618658097711785492504343953926634992332820282019728792003956564819968',
    makerAmount: 5_000_000,
    takerAmount: 10_000_000,
    expiration: '0',
    nonce: 0,
    feeRateBps: 300,
    side: 0,
    signatureType: 0,
  };
}

describe('SDK OrderSigner vs the documented EIP-712 struct', () => {
  const config: OrderSigningConfig = { chainId: CHAIN_ID, contractAddress: TEST_EXCHANGE };

  it('produces the same signature as viem signing the documented typed data', async () => {
    const order = sampleOrder();
    const sdkSignature = await new OrderSigner(new ethers.Wallet(TEST_PRIVATE_KEY)).signOrder(order, config);

    const account = privateKeyToAccount(TEST_PRIVATE_KEY);
    const viemSignature = await account.signTypedData({
      domain,
      types,
      primaryType: 'Order',
      message: {
        salt: BigInt(order.salt),
        maker: order.maker as `0x${string}`,
        signer: order.signer as `0x${string}`,
        taker: order.taker as `0x${string}`,
        tokenId: BigInt(order.tokenId),
        makerAmount: BigInt(order.makerAmount),
        takerAmount: BigInt(order.takerAmount),
        expiration: BigInt(order.expiration),
        nonce: BigInt(order.nonce),
        feeRateBps: BigInt(order.feeRateBps),
        side: order.side,
        signatureType: order.signatureType,
      },
    });

    expect(sdkSignature).toBe(viemSignature);
  });

  it('recovers to the signing wallet', async () => {
    const order = sampleOrder();
    const signature = await new OrderSigner(new ethers.Wallet(TEST_PRIVATE_KEY)).signOrder(order, config);
    const recovered = ethers.verifyTypedData(domain, types as unknown as Record<string, ethers.TypedDataField[]>, order, signature);
    expect(recovered.toLowerCase()).toBe(TEST_ADDRESS.toLowerCase());
  });
});
