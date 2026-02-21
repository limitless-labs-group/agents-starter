/**
 * auto-claim.ts — Example: Find resolved markets and claim winnings
 *
 * This example shows how to:
 *   1. Load a list of market slugs you've traded in
 *   2. Check which ones have resolved in your favour
 *   3. Claim all winnings in one go
 *
 * You can also claim a single market by slug with `redeemSingle()`.
 *
 * Run:
 *   npx tsx src/examples/auto-claim.ts
 *   npx tsx src/examples/auto-claim.ts <market-slug>   # claim one specific market
 *
 * Set DRY_RUN=true in your .env to simulate without sending any transactions.
 */

import dotenv from 'dotenv';
dotenv.config();

import { RedeemClient } from '../core/limitless/redeem.js';

// ─── Config ──────────────────────────────────────────────────────────────────

/**
 * List of market slugs you have (or may have) traded in.
 *
 * In a real bot, you'd populate this from your trade history or a local log.
 * You can also use the learnings.jsonl file if you're running the signal-sniper
 * strategy — see the `claim-all` CLI command in redeem.ts.
 */
const MY_MARKET_SLUGS: string[] = [
    // Add slugs here, e.g.:
    // 'btc-above-100000-2025-06-01',
    // 'eth-above-4000-2025-06-01',
];

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
    const client = new RedeemClient();
    console.log('Redeem wallet:', client.getAddress());

    // Allow passing a single slug as a CLI arg
    const singleSlug = process.argv[2];

    if (singleSlug) {
        // ── Single-market claim (convenience wrapper) ────────────────────────
        console.log(`\nChecking and claiming: ${singleSlug}`);
        console.log('(This does the full flow: fetch → check resolved → check balance → redeem)');
        if (process.env.DRY_RUN === 'true') console.log('[DRY RUN mode]');

        const tx = await client.redeemSingle(singleSlug);

        if (tx) {
            console.log(`\n✅ Claimed! Transaction: ${tx}`);
        } else {
            console.log('\nℹ️  Nothing to claim for that market.');
            console.log('   Possible reasons:');
            console.log('   - Market is not resolved yet');
            console.log('   - You held the losing side');
            console.log('   - You already redeemed this position');
        }
        return;
    }

    // ── Batch claim across multiple markets ───────────────────────────────────

    if (MY_MARKET_SLUGS.length === 0) {
        console.log('\n⚠️  No market slugs configured.');
        console.log('   Edit MY_MARKET_SLUGS in this file, or pass a slug as a CLI argument:');
        console.log('   npx tsx src/examples/auto-claim.ts <market-slug>');
        return;
    }

    console.log(`\nChecking ${MY_MARKET_SLUGS.length} markets for claimable positions...`);
    if (process.env.DRY_RUN === 'true') console.log('[DRY RUN mode]');

    // Step 1: find which markets have winnings
    const claimable = await client.findClaimablePositions(MY_MARKET_SLUGS);

    if (claimable.length === 0) {
        console.log('\nℹ️  No claimable positions found.');
        return;
    }

    console.log(`\nFound ${claimable.length} claimable position(s):`);
    for (const pos of claimable) {
        console.log(`  ✓ ${pos.marketTitle}`);
        console.log(`      Side: ${pos.side}  |  Expected payout: ${pos.expectedPayout}`);
    }

    // Step 2: claim them all
    console.log('\nClaiming all positions...');
    const result = await client.claimAll(MY_MARKET_SLUGS);

    console.log(`\n✅ Done!`);
    console.log(`   Claimed:     ${result.claimed} position(s)`);
    console.log(`   Total value: ${result.totalValue} USDC`);
    if (result.txHashes.length > 0) {
        console.log('   Transactions:');
        result.txHashes.forEach(h => console.log(`     ${h}`));
    }
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
