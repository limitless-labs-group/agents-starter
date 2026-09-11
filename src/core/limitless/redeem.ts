/**
 * RedeemClient — claim winnings from resolved markets, on-chain, from your EOA.
 *
 * Limitless markets settle through the Conditional Tokens Framework (CTF).
 * Once a market resolves, the winning outcome token redeems for $1 of USDC:
 *
 *   - Standard binary markets: `ConditionalTokens.redeemPositions(USDC, 0x0,
 *     conditionId, [indexSet])` with indexSet 1 = YES, 2 = NO.
 *   - Neg-risk (grouped) markets: positions are minted under the NegRisk
 *     adapter's wrapped collateral, so the CTF call above sees a zero balance.
 *     Redeem through `NegRiskAdapter.redeemPositions(conditionId, [yesBal,
 *     noBal])` instead, with the amounts in the market's stored `[yes, no]`
 *     token order. The adapter needs a one-time CTF `setApprovalForAll`.
 *
 * Market reads go through the SDK (HMAC-signed, same base URL as trading).
 * Transactions are signed locally with viem and gated by `DRY_RUN`.
 *
 *   npm run redeem check <slug>
 *   npm run redeem claim <slug>
 *   npm run redeem claim-many <slug> <slug> ...
 *   npm run redeem claim-all            # every market in your positions
 *
 * @see https://docs.limitless.exchange/user-guide/smart-contracts
 */

import { createPublicClient, createWalletClient, http, parseAbi, formatUnits, type Address, type Hex } from 'viem';
import { base } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { pino } from 'pino';
import dotenv from 'dotenv';
import type { Client } from '@limitless-exchange/sdk';
import { createSdkClient } from './client.js';
import { normalizeMarket } from './markets.js';
import type { Market } from './types.js';

dotenv.config({ quiet: true });

const logger = pino({ level: process.env.LOG_LEVEL || 'info', name: 'redeem' });

/** Base mainnet CTF (Conditional Tokens Framework, ERC-1155). Not the Polygon address. */
export const CTF_ADDRESS: Address = '0xC9c98965297Bc527861c898329Ee280632B76e18';
/** Base mainnet USDC (6 decimals). */
export const USDC_ADDRESS: Address = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

const CTF_ABI = parseAbi([
  'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets) external',
  'function balanceOf(address account, uint256 id) view returns (uint256)',
  'function payoutDenominator(bytes32 conditionId) view returns (uint256)',
  'function isApprovedForAll(address owner, address operator) view returns (bool)',
  'function setApprovalForAll(address operator, bool approved) external',
]);

const NEG_RISK_ADAPTER_ABI = parseAbi([
  'function redeemPositions(bytes32 _conditionId, uint256[] _amounts) external',
]);

const PARENT_COLLECTION_ID: Hex = '0x0000000000000000000000000000000000000000000000000000000000000000';

export interface ClaimablePosition {
  marketSlug: string;
  marketTitle: string;
  conditionId: Hex;
  winningOutcomeIndex: number;
  side: 'YES' | 'NO';
  /** Winning-side token balance, raw (6 decimals). */
  balance: bigint;
  expectedPayout: string;
  /** Neg-risk markets redeem through the adapter with `[yes, no]` amounts. */
  negRisk?: { adapter: Address; amounts: [bigint, bigint] };
}

type ResolvedMarket = Market & { conditionId?: string; winningOutcomeIndex?: number | null };

export class RedeemClient {
  private readonly publicClient;
  private readonly walletClient;
  private readonly account;
  private readonly sdk: Client;

  constructor(sdk?: Client) {
    const privateKey = process.env.PRIVATE_KEY as Hex | undefined;
    if (!privateKey) throw new Error('PRIVATE_KEY not set');

    this.account = privateKeyToAccount(privateKey);
    this.publicClient = createPublicClient({ chain: base, transport: http() });
    this.walletClient = createWalletClient({ account: this.account, chain: base, transport: http() });
    this.sdk = sdk ?? createSdkClient();
  }

  getAddress(): Address {
    return this.account.address;
  }

  /** A condition is settled on-chain once `payoutDenominator > 0`. */
  async isResolved(conditionId: Hex): Promise<boolean> {
    try {
      const denominator = await this.publicClient.readContract({
        address: CTF_ADDRESS,
        abi: CTF_ABI,
        functionName: 'payoutDenominator',
        args: [conditionId],
      });
      return denominator > 0n;
    } catch {
      return false;
    }
  }

  /** ERC-1155 position balance for this wallet. */
  async getPositionBalance(tokenId: bigint): Promise<bigint> {
    try {
      return await this.publicClient.readContract({
        address: CTF_ADDRESS,
        abi: CTF_ABI,
        functionName: 'balanceOf',
        args: [this.account.address, tokenId],
      });
    } catch {
      return 0n;
    }
  }

  async getCurrentNonce(): Promise<number> {
    return this.publicClient.getTransactionCount({ address: this.account.address });
  }

  async waitForReceipts(hashes: string[]): Promise<void> {
    if (!hashes.length) return;
    await Promise.all(hashes.map((h) => this.waitForReceipt(h)));
  }

  /**
   * Redeem a standard (non neg-risk) condition. `indexSets`: `[1]` = YES,
   * `[2]` = NO, `[1, 2]` = both. Returns the tx hash, or null on failure.
   */
  async redeemPositions(conditionId: Hex, indexSets: number[], nonce?: number): Promise<string | null> {
    if (process.env.DRY_RUN === 'true') {
      logger.info({ conditionId, indexSets }, 'DRY RUN: Would redeem positions');
      return 'dry-run-tx';
    }
    try {
      logger.info({ conditionId, indexSets }, 'Redeeming positions...');
      const hash = await this.walletClient.writeContract({
        address: CTF_ADDRESS,
        abi: CTF_ABI,
        functionName: 'redeemPositions',
        args: [USDC_ADDRESS, PARENT_COLLECTION_ID, conditionId, indexSets.map((i) => BigInt(i))],
        ...(nonce !== undefined ? { nonce } : {}),
      });
      logger.info({ conditionId, hash }, 'Redemption submitted');
      return hash;
    } catch (e) {
      logger.error({ conditionId, error: (e as Error).message }, 'Redemption failed');
      return null;
    }
  }

  /**
   * Redeem a neg-risk condition through the adapter. `amounts` must be the
   * `[yesBalance, noBalance]` of the market's stored token ids, in that order.
   * Approves the adapter on the CTF first if it is not already approved.
   */
  async redeemNegRiskPositions(
    adapter: Address,
    conditionId: Hex,
    amounts: [bigint, bigint],
    nonce?: number,
  ): Promise<string | null> {
    if (process.env.DRY_RUN === 'true') {
      logger.info({ conditionId, adapter, amounts: amounts.map(String) }, 'DRY RUN: Would redeem neg-risk positions');
      return 'dry-run-tx';
    }
    try {
      const approved = await this.publicClient.readContract({
        address: CTF_ADDRESS,
        abi: CTF_ABI,
        functionName: 'isApprovedForAll',
        args: [this.account.address, adapter],
      });
      if (!approved) {
        logger.info({ adapter }, 'Approving neg-risk adapter on CTF (one-time)...');
        const approveHash = await this.walletClient.writeContract({
          address: CTF_ADDRESS,
          abi: CTF_ABI,
          functionName: 'setApprovalForAll',
          args: [adapter, true],
          ...(nonce !== undefined ? { nonce: nonce++ } : {}),
        });
        await this.publicClient.waitForTransactionReceipt({ hash: approveHash });
      }
      const hash = await this.walletClient.writeContract({
        address: adapter,
        abi: NEG_RISK_ADAPTER_ABI,
        functionName: 'redeemPositions',
        args: [conditionId, [amounts[0], amounts[1]]],
        ...(nonce !== undefined ? { nonce } : {}),
      });
      logger.info({ conditionId, hash }, 'Neg-risk redemption submitted');
      return hash;
    } catch (e) {
      logger.error({ conditionId, error: (e as Error).message }, 'Neg-risk redemption failed');
      return null;
    }
  }

  /** Submit the right redeem call for a claimable position. */
  async redeemClaimable(position: ClaimablePosition, nonce?: number): Promise<string | null> {
    if (position.negRisk) {
      return this.redeemNegRiskPositions(position.negRisk.adapter, position.conditionId, position.negRisk.amounts, nonce);
    }
    const indexSet = position.winningOutcomeIndex === 0 ? 1 : 2;
    return this.redeemPositions(position.conditionId, [indexSet], nonce);
  }

  private async waitForReceipt(hash: string, timeoutMs = 30_000): Promise<boolean> {
    try {
      const receipt = await this.publicClient.waitForTransactionReceipt({ hash: hash as Hex, timeout: timeoutMs });
      logger.info({ hash, status: receipt.status }, 'Redemption confirmed');
      return receipt.status === 'success';
    } catch (e) {
      logger.warn({ hash, error: (e as Error).message }, 'Waiting for receipt timed out — tx may still confirm');
      return false;
    }
  }

  private async fetchMarket(slug: string): Promise<ResolvedMarket> {
    return normalizeMarket(await this.sdk.markets.getMarket(slug)) as ResolvedMarket;
  }

  /** Inspect one market and return the claimable position, if any. */
  async findClaimable(slug: string): Promise<ClaimablePosition | null> {
    const market = await this.fetchMarket(slug);
    if (market.status !== 'RESOLVED') return null;
    if (market.winningOutcomeIndex === null || market.winningOutcomeIndex === undefined) {
      logger.debug({ slug }, 'RESOLVED but winningOutcomeIndex is null — resolution still propagating');
      return null;
    }
    if (!market.conditionId) return null;

    const conditionId = market.conditionId as Hex;
    const winningIndex = market.winningOutcomeIndex;
    const side = winningIndex === 0 ? 'YES' : 'NO';
    const yesId = market.positionIds?.[0];
    const noId = market.positionIds?.[1];
    if (!yesId || !noId) {
      logger.warn({ slug }, 'Could not determine token ids — market.tokens missing');
      return null;
    }

    const [yesBal, noBal] = await Promise.all([this.getPositionBalance(BigInt(yesId)), this.getPositionBalance(BigInt(noId))]);
    const balance = winningIndex === 0 ? yesBal : noBal;
    if (balance === 0n) return null;

    const isNegRisk = Boolean(market.negRiskRequestId) && Boolean(market.venue?.adapter);
    return {
      marketSlug: slug,
      marketTitle: market.title,
      conditionId,
      winningOutcomeIndex: winningIndex,
      side,
      balance,
      expectedPayout: formatUnits(balance, 6) + ' USDC',
      ...(isNegRisk ? { negRisk: { adapter: market.venue!.adapter as Address, amounts: [yesBal, noBal] as [bigint, bigint] } } : {}),
    };
  }

  /** Full claim flow for a single market. Returns the tx hash, or null if nothing to claim. */
  async redeemSingle(slug: string): Promise<string | null> {
    const claimable = await this.findClaimable(slug);
    if (!claimable) {
      logger.info({ slug }, 'Nothing to claim');
      return null;
    }
    logger.info(
      { slug, side: claimable.side, payout: claimable.expectedPayout, negRisk: Boolean(claimable.negRisk) },
      'Found claimable position — redeeming...',
    );
    const hash = await this.redeemClaimable(claimable);
    if (hash) await this.waitForReceipt(hash);
    return hash;
  }

  /** Claimable positions across many markets, checked 3 at a time. */
  async findClaimablePositions(marketSlugs: string[]): Promise<ClaimablePosition[]> {
    const claimable: ClaimablePosition[] = [];
    const uniqueSlugs = [...new Set(marketSlugs)];
    const batchSize = 3;
    for (let i = 0; i < uniqueSlugs.length; i += batchSize) {
      const batch = uniqueSlugs.slice(i, i + batchSize);
      const results = await Promise.all(
        batch.map((slug) =>
          this.findClaimable(slug).catch((e: Error) => {
            logger.debug({ slug, error: e.message }, 'Error checking market');
            return null;
          }),
        ),
      );
      claimable.push(...results.filter((r): r is ClaimablePosition => r !== null));
    }
    return claimable;
  }

  /** Claim every winning position across the given markets, one tx each with sequential nonces. */
  async claimAll(marketSlugs: string[]): Promise<{ claimed: number; totalValue: string; txHashes: string[] }> {
    const claimable = await this.findClaimablePositions(marketSlugs);
    if (claimable.length === 0) {
      logger.info('No claimable positions found');
      return { claimed: 0, totalValue: '0', txHashes: [] };
    }
    logger.info({ count: claimable.length }, 'Found claimable positions');

    let nonce = await this.getCurrentNonce();
    const txHashes: string[] = [];
    let totalValue = 0n;

    for (const position of claimable) {
      logger.info(
        { market: position.marketTitle, side: position.side, payout: position.expectedPayout, nonce },
        'Submitting claim...',
      );
      // A neg-risk claim may spend an extra nonce on the one-time adapter approval;
      // re-read the nonce after it so the next claim never collides.
      const hash = await this.redeemClaimable(position, position.negRisk ? undefined : nonce);
      if (hash) {
        txHashes.push(hash);
        totalValue += position.balance;
        nonce = position.negRisk ? await this.getCurrentNonce() : nonce + 1;
      }
    }

    if (txHashes.length > 0) {
      logger.info({ count: txHashes.length }, 'Waiting for all receipts...');
      await this.waitForReceipts(txHashes);
    }
    return { claimed: txHashes.length, totalValue: formatUnits(totalValue, 6), txHashes };
  }

  /** Slugs of every market in the authenticated portfolio (CLOB + group). */
  async portfolioSlugs(): Promise<string[]> {
    const positions = await this.sdk.portfolio.getPositions();
    const slugs = new Set<string>();
    for (const p of positions.clob ?? []) if (p.market?.slug) slugs.add(p.market.slug);
    for (const p of (positions.group ?? []) as Array<{ market?: { slug?: string }; marketSlug?: string }>) {
      const slug = p.market?.slug ?? p.marketSlug;
      if (slug) slugs.add(slug);
    }
    return [...slugs];
  }
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

const USAGE = `
Usage:
  npm run redeem check <market-slug>          Check for claimable positions
  npm run redeem claim <market-slug>          Claim a single market
  npm run redeem claim-many <slug1> <slug2>   Claim multiple specific markets
  npm run redeem claim-all                    Claim all winnings from portfolio positions
`;

async function main() {
  const client = new RedeemClient();
  console.log('Redeem client for:', client.getAddress());
  const [cmd, ...rest] = process.argv.slice(2);

  switch (cmd) {
    case 'check': {
      if (!rest[0]) return console.log(USAGE);
      console.log('Claimable positions:', await client.findClaimablePositions([rest[0]]));
      break;
    }
    case 'claim': {
      if (!rest[0]) return console.log(USAGE);
      const tx = await client.redeemSingle(rest[0]);
      console.log(tx ? `Claimed! tx: ${tx}` : 'Nothing to claim.');
      break;
    }
    case 'claim-many': {
      if (rest.length === 0) return console.log(USAGE);
      console.log('Claim result:', await client.claimAll(rest));
      break;
    }
    case 'claim-all': {
      console.log('Fetching portfolio positions...');
      const slugs = await client.portfolioSlugs();
      if (slugs.length === 0) {
        console.log('No portfolio positions found.');
        break;
      }
      console.log(`Checking ${slugs.length} markets for claimable winnings...`);
      console.log('Claim result:', await client.claimAll(slugs));
      break;
    }
    default:
      console.log(USAGE);
  }
}

const isDirectRun = process.argv[1] && /redeem\.(ts|js)$/.test(process.argv[1]);
if (isDirectRun) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
