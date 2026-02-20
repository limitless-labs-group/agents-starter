/**
 * Auto-Redeem - Claim winnings from resolved Limitless markets
 * 
 * Uses Conditional Tokens Framework (CTF) - same as Polymarket/Gnosis.
 * When a market resolves, call redeemPositions() to convert winning tokens → USDC.
 */

import { createPublicClient, createWalletClient, http, parseAbi, formatUnits, encodeFunctionData } from 'viem';
import { base } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { pino } from 'pino';
import fetch from 'cross-fetch';
import dotenv from 'dotenv';

dotenv.config();

const logger = pino({ level: process.env.LOG_LEVEL || 'info', name: 'redeem' });

// Limitless CTF Contract (Conditional Tokens Framework) - for token balances & redemption
// NOTE: This is Base chain specific - NOT the Polygon/Polymarket address
const CTF_ADDRESS = '0xC9c98965297Bc527861c898329Ee280632B76e18';
// Exchange contract (for trading) - different from CTF
const EXCHANGE_ADDRESS = '0x05c748E2f4DcDe0ec9Fa8DDc40DE6b867f923fa5';
const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const API_BASE = 'https://api.limitless.exchange';

// CTF ABI - subset for redemptions
const CTF_ABI = parseAbi([
  // Redeem winning positions for collateral
  'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets) external',
  // Check position balance (ERC-1155)
  'function balanceOf(address account, uint256 id) view returns (uint256)',
  // Check if condition is resolved
  'function payoutDenominator(bytes32 conditionId) view returns (uint256)',
  'function payoutNumerators(bytes32 conditionId, uint256 index) view returns (uint256)',
]);

// Zero bytes32 for root parent collection
const PARENT_COLLECTION_ID = '0x0000000000000000000000000000000000000000000000000000000000000000' as `0x${string}`;

export interface ClaimablePosition {
  marketSlug: string;
  marketTitle: string;
  conditionId: `0x${string}`;
  winningOutcomeIndex: number;
  side: 'YES' | 'NO';
  balance: bigint;
  expectedPayout: string;
}

export class RedeemClient {
  private publicClient;
  private walletClient;
  private account;

  constructor() {
    const privateKey = process.env.PRIVATE_KEY as `0x${string}`;
    if (!privateKey) throw new Error('PRIVATE_KEY not set');

    this.account = privateKeyToAccount(privateKey);
    this.publicClient = createPublicClient({
      chain: base,
      transport: http(),
    });
    this.walletClient = createWalletClient({
      account: this.account,
      chain: base,
      transport: http(),
    });
  }

  getAddress(): string {
    return this.account.address;
  }

  /**
   * Check if a condition is resolved
   */
  async isResolved(conditionId: `0x${string}`): Promise<boolean> {
    try {
      const denominator = await this.publicClient.readContract({
        address: CTF_ADDRESS,
        abi: CTF_ABI,
        functionName: 'payoutDenominator',
        args: [conditionId],
      });
      return (denominator as bigint) > 0n;
    } catch (e) {
      return false;
    }
  }

  /**
   * Get position token balance
   * Token ID is derived from conditionId + outcomeIndex
   */
  async getPositionBalance(tokenId: bigint): Promise<bigint> {
    try {
      const balance = await this.publicClient.readContract({
        address: CTF_ADDRESS,
        abi: CTF_ABI,
        functionName: 'balanceOf',
        args: [this.account.address, tokenId],
      });
      return balance as bigint;
    } catch (e) {
      return 0n;
    }
  }

  /**
   * Redeem positions for a resolved market
   * 
   * @param conditionId - The market's condition ID
   * @param indexSets - Which outcomes to redeem: [1]=YES, [2]=NO, [1,2]=both
   */
  async redeemPositions(conditionId: `0x${string}`, indexSets: number[]): Promise<string | null> {
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
        args: [
          USDC_ADDRESS,
          PARENT_COLLECTION_ID,
          conditionId,
          indexSets.map(i => BigInt(i)),
        ],
      });

      logger.info({ conditionId, hash }, '✅ Redemption submitted');
      
      // Wait for confirmation
      const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
      logger.info({ hash, status: receipt.status }, 'Redemption confirmed');
      
      return hash;
    } catch (e: any) {
      logger.error({ conditionId, error: e.message }, '❌ Redemption failed');
      return null;
    }
  }

  /**
   * Find all claimable positions from our trade history
   */
  async findClaimablePositions(marketSlugs: string[]): Promise<ClaimablePosition[]> {
    const claimable: ClaimablePosition[] = [];
    const headers = {
      'Content-Type': 'application/json',
      'X-API-Key': process.env.LIMITLESS_API_KEY || '',
    };

    for (const slug of marketSlugs) {
      try {
        // Fetch market details
        const res = await fetch(`${API_BASE}/markets/${slug}`, { headers });
        if (!res.ok) continue;
        
        const market = await res.json();
        
        // Skip if not resolved
        if (market.status !== 'RESOLVED') continue;
        if (market.winningOutcomeIndex === null || market.winningOutcomeIndex === undefined) continue;
        
        const conditionId = market.conditionId as `0x${string}`;
        const winningIndex = market.winningOutcomeIndex;
        const winningSide = winningIndex === 0 ? 'YES' : 'NO';
        
        // Check if we have winning tokens
        // For binary markets: YES token = position 0, NO token = position 1
        // Token IDs are stored in market.tokens.yes and market.tokens.no
        const tokenId = winningIndex === 0 
          ? BigInt(market.tokens?.yes || 0) 
          : BigInt(market.tokens?.no || 0);
        
        if (tokenId === 0n) continue;
        
        const balance = await this.getPositionBalance(tokenId);
        
        if (balance > 0n) {
          claimable.push({
            marketSlug: slug,
            marketTitle: market.title,
            conditionId,
            winningOutcomeIndex: winningIndex,
            side: winningSide,
            balance,
            expectedPayout: formatUnits(balance, 6) + ' USDC',
          });
        }
      } catch (e: any) {
        logger.debug({ slug, error: e.message }, 'Error checking market');
      }
    }

    return claimable;
  }

  /**
   * Claim all available winnings
   */
  async claimAll(marketSlugs: string[]): Promise<{ claimed: number; totalValue: string; txHashes: string[] }> {
    const claimable = await this.findClaimablePositions(marketSlugs);
    
    if (claimable.length === 0) {
      logger.info('No claimable positions found');
      return { claimed: 0, totalValue: '0', txHashes: [] };
    }

    logger.info({ count: claimable.length }, 'Found claimable positions');
    
    const txHashes: string[] = [];
    let totalValue = 0n;

    for (const position of claimable) {
      logger.info({
        market: position.marketTitle,
        side: position.side,
        payout: position.expectedPayout,
      }, 'Claiming position...');

      // Index set: 1 for YES (2^0), 2 for NO (2^1)
      const indexSet = position.winningOutcomeIndex === 0 ? 1 : 2;
      
      const hash = await this.redeemPositions(position.conditionId, [indexSet]);
      
      if (hash) {
        txHashes.push(hash);
        totalValue += position.balance;
      }
    }

    return {
      claimed: txHashes.length,
      totalValue: formatUnits(totalValue, 6),
      txHashes,
    };
  }
}

// CLI
async function main() {
  const client = new RedeemClient();
  console.log('Redeem Client for:', client.getAddress());
  
  const cmd = process.argv[2];
  
  switch (cmd) {
    case 'check': {
      // Check a specific market
      const slug = process.argv[3];
      if (!slug) {
        console.log('Usage: npx tsx src/core/limitless/redeem.ts check <market-slug>');
        break;
      }
      const positions = await client.findClaimablePositions([slug]);
      console.log('Claimable positions:', positions);
      break;
    }
    
    case 'claim': {
      // Claim from specific markets
      const slugs = process.argv.slice(3);
      if (slugs.length === 0) {
        console.log('Usage: npx tsx src/core/limitless/redeem.ts claim <slug1> <slug2> ...');
        break;
      }
      const result = await client.claimAll(slugs);
      console.log('Claim result:', result);
      break;
    }
    
    case 'claim-all': {
      // Load markets from learnings.jsonl and claim all
      const { readFileSync, existsSync } = await import('fs');
      const learningsFile = './learnings.jsonl';
      
      if (!existsSync(learningsFile)) {
        console.log('No learnings.jsonl found');
        break;
      }
      
      const lines = readFileSync(learningsFile, 'utf-8').trim().split('\n');
      const slugs = [...new Set(lines.map(l => JSON.parse(l).market))];
      
      console.log(`Found ${slugs.length} unique markets in learnings`);
      const result = await client.claimAll(slugs);
      console.log('Claim result:', result);
      break;
    }
    
    default:
      console.log(`
Usage:
  npx tsx src/core/limitless/redeem.ts check <market-slug>   - Check if market has claimable positions
  npx tsx src/core/limitless/redeem.ts claim <slug1> ...    - Claim specific markets
  npx tsx src/core/limitless/redeem.ts claim-all            - Claim all from learnings.jsonl
      `);
  }
}

main().catch(console.error);
