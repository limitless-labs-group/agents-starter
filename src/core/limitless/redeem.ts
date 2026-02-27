/**
 * Auto-Redeem - Claim winnings from resolved Limitless markets
 *
 * Uses Conditional Tokens Framework (CTF) — same as Polymarket/Gnosis.
 * When a market resolves, call redeemPositions() to convert winning tokens → USDC.
 *
 * Quick start:
 *   const client = new RedeemClient();
 *   await client.redeemSingle('btc-above-100k-2025-06-01');
 */

import { createPublicClient, createWalletClient, http, parseAbi, formatUnits } from 'viem';
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
     * Check whether a market condition has been resolved on-chain.
     * A condition is resolved when `payoutDenominator > 0`.
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
        } catch {
            return false;
        }
    }

    /**
     * Get ERC-1155 position token balance for the current wallet.
     * Token ID is derived from conditionId + outcomeIndex.
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
        } catch {
            return 0n;
        }
    }

    /**
     * Redeem winning positions for a resolved market.
     *
     * @param conditionId - The market's condition ID (from `market.conditionId`)
     * @param indexSets   - Which outcomes to redeem: `[1]` = YES, `[2]` = NO, `[1,2]` = both
     * @returns Transaction hash, or null on failure
     *
     * @example
     * // Claim YES winnings
     * await client.redeemPositions('0xabc...', [1]);
     * // Claim both (in case you held both sides)
     * await client.redeemPositions('0xabc...', [1, 2]);
     */
    async redeemPositions(conditionId: `0x${string}`, indexSets: number[], nonce?: number): Promise<string | null> {
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
                ...(nonce !== undefined ? { nonce } : {}),
            });

            logger.info({ conditionId, hash }, 'SUCCESS: Redemption submitted');
            return hash;
        } catch (e: any) {
            logger.error({ conditionId, error: e.message }, 'ERROR: Redemption failed');
            return null;
        }
    }

    /** Wait for a tx receipt, with timeout */
    private async waitForReceipt(hash: string, timeoutMs = 30_000): Promise<boolean> {
        try {
            const receipt = await this.publicClient.waitForTransactionReceipt({
                hash: hash as `0x${string}`,
                timeout: timeoutMs,
            });
            logger.info({ hash, status: receipt.status }, 'Redemption confirmed');
            return receipt.status === 'success';
        } catch (e: any) {
            logger.warn({ hash, error: e.message }, 'Waiting for receipt timed out — tx may still confirm');
            return false;
        }
    }

    /**
     * Convenience: full claim flow for a single market by slug.
     *
     * 1. Fetches the market from the API.
     * 2. Checks if `winningOutcomeIndex` is set (market resolved).
     * 3. Checks your token balance.
     * 4. Calls `redeemPositions` if you have tokens to claim.
     *
     * @returns Transaction hash if claimed, `null` if nothing to claim or already redeemed.
     *
     * @example
     * const tx = await client.redeemSingle('btc-above-100k-2025-06-01');
     * if (tx) console.log('Claimed! tx:', tx);
     */
    async redeemSingle(slug: string): Promise<string | null> {
        const headers = {
            'Content-Type': 'application/json',
            ...(process.env.LIMITLESS_API_KEY ? { 'X-API-Key': process.env.LIMITLESS_API_KEY } : {}),
        };

        const res = await fetch(`${API_BASE}/markets/${slug}`, { headers });
        if (!res.ok) throw new Error(`Failed to fetch market ${slug}: ${res.status}`);

        const market = await res.json();

        if (market.status !== 'RESOLVED') {
            logger.info({ slug, status: market.status }, 'Market not yet resolved — nothing to claim');
            return null;
        }

        if (market.winningOutcomeIndex === null || market.winningOutcomeIndex === undefined) {
            logger.warn(
                { slug },
                'Market is RESOLVED but winningOutcomeIndex is null. ' +
                'This usually means resolution is still being processed on-chain. ' +
                'Try again in a few minutes.',
            );
            return null;
        }

        const conditionId = market.conditionId as `0x${string}`;
        const winningIndex: number = market.winningOutcomeIndex;
        const winningSide = winningIndex === 0 ? 'YES' : 'NO';

        const tokenId = winningIndex === 0
            ? BigInt(market.tokens?.yes || 0)
            : BigInt(market.tokens?.no || 0);

        if (tokenId === 0n) {
            logger.warn({ slug }, 'Could not determine token ID — market.tokens may be missing');
            return null;
        }

        const balance = await this.getPositionBalance(tokenId);

        if (balance === 0n) {
            logger.info({ slug, side: winningSide }, 'No winning tokens to redeem');
            return null;
        }

        logger.info(
            { slug, side: winningSide, balance: formatUnits(balance, 6) + ' USDC' },
            'Found claimable position — redeeming...',
        );

        // Index set: 1 for YES (2^0), 2 for NO (2^1)
        const indexSet = winningIndex === 0 ? 1 : 2;
        const hash = await this.redeemPositions(conditionId, [indexSet]);
        if (hash) await this.waitForReceipt(hash);
        return hash;
    }

    /**
     * Find all claimable positions across a list of market slugs.
     * Useful when you want to batch-check many markets before redeeming.
     * Runs checks in parallel with concurrency limiting for speed.
     */
    async findClaimablePositions(marketSlugs: string[]): Promise<ClaimablePosition[]> {
        const claimable: ClaimablePosition[] = [];
        const headers = {
            'Content-Type': 'application/json',
            ...(process.env.LIMITLESS_API_KEY ? { 'X-API-Key': process.env.LIMITLESS_API_KEY } : {}),
        };

        // Process in batches of 3 to avoid overwhelming the API/rpc
        const batchSize = 3;
        const uniqueSlugs = [...new Set(marketSlugs)];
        
        for (let i = 0; i < uniqueSlugs.length; i += batchSize) {
            const batch = uniqueSlugs.slice(i, i + batchSize);
            const batchResults = await Promise.all(
                batch.map(async (slug) => {
                    try {
                        const res = await fetch(`${API_BASE}/markets/${slug}`, { headers });
                        if (!res.ok) return null;

                        const market = await res.json();

                        if (market.status !== 'RESOLVED') return null;

                        if (market.winningOutcomeIndex === null || market.winningOutcomeIndex === undefined) {
                            logger.debug(
                                { slug },
                                'Market RESOLVED but winningOutcomeIndex is null — skipping (resolution still propagating)',
                            );
                            return null;
                        }

                        const conditionId = market.conditionId as `0x${string}`;
                        const winningIndex = market.winningOutcomeIndex;
                        const winningSide = winningIndex === 0 ? 'YES' : 'NO';

                        const tokenId = winningIndex === 0
                            ? BigInt(market.tokens?.yes || 0)
                            : BigInt(market.tokens?.no || 0);

                        if (tokenId === 0n) return null;

                        const balance = await this.getPositionBalance(tokenId);

                        if (balance > 0n) {
                            return {
                                marketSlug: slug,
                                marketTitle: market.title,
                                conditionId,
                                winningOutcomeIndex: winningIndex,
                                side: winningSide,
                                balance,
                                expectedPayout: formatUnits(balance, 6) + ' USDC',
                            };
                        }
                    } catch (e: any) {
                        logger.debug({ slug, error: e.message }, 'Error checking market');
                    }
                    return null;
                })
            );
            
            claimable.push(...batchResults.filter((r): r is ClaimablePosition => r !== null));
        }

        return claimable;
    }

    /**
     * Claim all available winnings across a list of market slugs.
     *
     * @example
     * const result = await client.claimAll(['market-a', 'market-b']);
     * console.log(`Claimed ${result.claimed} positions, total: ${result.totalValue} USDC`);
     */
    async claimAll(marketSlugs: string[]): Promise<{ claimed: number; totalValue: string; txHashes: string[] }> {
        const claimable = await this.findClaimablePositions(marketSlugs);

        if (claimable.length === 0) {
            logger.info('No claimable positions found');
            return { claimed: 0, totalValue: '0', txHashes: [] };
        }

        logger.info({ count: claimable.length }, 'Found claimable positions');

        // Get nonce once — increment manually so concurrent claims don't collide
        let nonce = await this.publicClient.getTransactionCount({ address: this.account.address });
        logger.info({ nonce, count: claimable.length }, 'Firing claims with sequential nonces');

        const txHashes: string[] = [];
        let totalValue = 0n;

        // Fire all txs back-to-back (no waiting for receipts between them)
        for (const position of claimable) {
            logger.info({
                market: position.marketTitle,
                side: position.side,
                payout: position.expectedPayout,
                nonce,
            }, 'Submitting claim...');

            const indexSet = position.winningOutcomeIndex === 0 ? 1 : 2;
            const hash = await this.redeemPositions(position.conditionId, [indexSet], nonce);

            if (hash) {
                txHashes.push(hash);
                totalValue += position.balance;
                nonce++; // next tx uses next nonce
            }
        }

        // Now wait for all receipts in parallel
        if (txHashes.length > 0) {
            logger.info({ count: txHashes.length }, 'Waiting for all receipts...');
            await Promise.all(txHashes.map(h => this.waitForReceipt(h)));
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
            const slug = process.argv[3];
            if (!slug) {
                console.log('Usage: npx tsx src/core/limitless/redeem.ts claim <market-slug>');
                break;
            }
            // Use the convenience method for single-market claims
            const tx = await client.redeemSingle(slug);
            console.log(tx ? `Claimed! tx: ${tx}` : 'Nothing to claim.');
            break;
        }

        case 'claim-many': {
            const slugs = process.argv.slice(3);
            if (slugs.length === 0) {
                console.log('Usage: npx tsx src/core/limitless/redeem.ts claim-many <slug1> <slug2> ...');
                break;
            }
            const result = await client.claimAll(slugs);
            console.log('Claim result:', result);
            break;
        }

        case 'claim-all': {
            // Fetch portfolio positions via the API (with fallback to local file).
            console.log('Fetching portfolio positions...');

            const headers = {
                'Content-Type': 'application/json',
                ...(process.env.LIMITLESS_API_KEY ? { 'X-API-Key': process.env.LIMITLESS_API_KEY } : {}),
            };

            let slugs: string[] = [];
            
            // Try API first
            try {
                const posRes = await fetch(`${API_BASE}/portfolio/positions`, { headers });
                if (posRes.ok) {
                    const raw = await posRes.json();
                    const positions: any[] = Array.isArray(raw)
                        ? raw
                        : [
                            ...(raw.clob ?? []),
                            ...(raw.amm ?? []),
                            ...(raw.group ?? []),
                        ];
                    
                    const slugSet = new Set<string>();
                    for (const pos of positions) {
                        const slug = pos.market?.slug ?? pos.marketSlug;
                        if (slug) slugSet.add(slug);
                    }
                    slugs = [...slugSet];
                    console.log(`Found ${slugs.length} markets from API`);
                }
            } catch (e) {
                console.log('API fetch failed, falling back to local file');
            }
            
            // Fallback to local positions file
            if (slugs.length === 0) {
                try {
                    const fs = await import('fs');
                    const path = await import('path');
                    const posFile = path.default.join(process.cwd(), 'data', 'oracle-arb-positions.json');
                    if (fs.existsSync(posFile)) {
                        const content = fs.readFileSync(posFile, 'utf8');
                        const positions = JSON.parse(content);
                        const slugSet = new Set<string>();
                        for (const [slug, pos] of Object.entries(positions)) {
                            if (slug) slugSet.add(slug);
                        }
                        slugs = [...slugSet];
                        console.log(`Found ${slugs.length} markets from local file`);
                    }
                } catch (e: any) {
                    console.error('Failed to read local positions:', e.message);
                }
            }

            if (slugs.length === 0) {
                console.log('No portfolio positions found.');
                break;
            }

            console.log(`Checking ${slugs.length} markets for claimable winnings...`);
            const result = await client.claimAll(slugs);
            console.log('Claim result:', result);
            break;
        }

        default:
            console.log(`
Usage:
  npx tsx src/core/limitless/redeem.ts check <market-slug>         Check for claimable positions
  npx tsx src/core/limitless/redeem.ts claim <market-slug>         Claim a single market (full flow)
  npx tsx src/core/limitless/redeem.ts claim-many <slug1> ...      Claim multiple specific markets
  npx tsx src/core/limitless/redeem.ts claim-all                   Claim all winnings from portfolio positions
      `);
    }
}

main().catch(console.error);
