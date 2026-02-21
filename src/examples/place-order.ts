/**
 * place-order.ts — Example: Find a market, place a GTC order, verify fill
 *
 * This is the simplest end-to-end trading flow. It covers:
 *   1. Finding an active market by search query
 *   2. Placing a GTC (resting) limit order
 *   3. Checking whether the order actually filled using portfolio positions
 *
 * Run:
 *   cp .env.example .env   # fill in PRIVATE_KEY and LIMITLESS_API_KEY
 *   npx tsx src/examples/place-order.ts
 *
 * Set DRY_RUN=true in your .env to simulate without submitting.
 */

import dotenv from 'dotenv';
dotenv.config();

import { createWalletClient, createPublicClient, http } from 'viem';
import { base } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';

import { LimitlessClient } from '../core/limitless/markets.js';
import { TradingClient } from '../core/limitless/trading.js';
import { PortfolioClient } from '../core/limitless/portfolio.js';
import { OrderSigner } from '../core/limitless/sign.js';

// ─── Config ──────────────────────────────────────────────────────────────────

// What market to search for — change this to any topic you like
const SEARCH_QUERY = 'BTC above';

// The side of the market you want to bet on
const SIDE: 'YES' | 'NO' = 'YES';

// Limit price in cents (1–99). 50 = 50¢ per contract = implied 50% probability.
const LIMIT_PRICE_CENTS = 50;

// How many USD to spend
const USD_AMOUNT = 2;

// How long to wait after placing before checking fill (ms)
const FILL_CHECK_DELAY_MS = 3000;

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
    const privateKey = process.env.PRIVATE_KEY as `0x${string}`;
    if (!privateKey) throw new Error('PRIVATE_KEY not set in .env');

    const account = privateKeyToAccount(privateKey);
    console.log('Wallet:', account.address);

    // Set up viem clients
    const walletClient = createWalletClient({ account, chain: base, transport: http() });
    const publicClient = createPublicClient({ chain: base, transport: http() });

    // Initialise Limitless SDK clients
    const markets = new LimitlessClient();
    const signer = new OrderSigner(walletClient, account);
    const trading = new TradingClient(markets, signer);
    const portfolio = new PortfolioClient();

    // 1. Find a market ─────────────────────────────────────────────────────────
    console.log(`\nSearching for markets: "${SEARCH_QUERY}"...`);
    const results = await markets.searchMarkets(SEARCH_QUERY, { limit: 5 });

    if (results.length === 0) {
        console.log('No markets found. Try a different query.');
        return;
    }

    // Pick the first result
    const market = results[0];
    console.log(`Found: ${market.title}`);
    console.log(`  Slug:    ${market.slug}`);
    console.log(`  Prices:  YES=${market.prices?.[0]}¢  NO=${market.prices?.[1]}¢`);
    console.log(`  Expires: ${new Date(market.expirationTimestamp).toISOString()}`);

    // 2. Place a GTC order ─────────────────────────────────────────────────────
    console.log(`\nPlacing GTC order: $${USD_AMOUNT} on ${SIDE} @ ${LIMIT_PRICE_CENTS}¢`);
    if (process.env.DRY_RUN === 'true') {
        console.log('  [DRY RUN mode — no real order will be sent]');
    }

    let orderResult: any;
    try {
        orderResult = await trading.createOrder({
            marketSlug: market.slug,
            side: SIDE,
            limitPriceCents: LIMIT_PRICE_CENTS,
            usdAmount: USD_AMOUNT,
            orderType: 'GTC',
        });
        console.log('Order result:', orderResult);
    } catch (err: any) {
        console.error('Order failed:', err.message);
        return;
    }

    // 3. Verify fill via portfolio positions ───────────────────────────────────
    //
    // Important: order.execution.matched only tells you about *immediate* matching.
    // For GTC orders that rest in the book and fill later, you must check your
    // portfolio positions directly — that is the ground truth.
    //
    console.log(`\nWaiting ${FILL_CHECK_DELAY_MS / 1000}s before checking fill...`);
    await new Promise(r => setTimeout(r, FILL_CHECK_DELAY_MS));

    const { filled, balance } = await portfolio.verifyFill(market.slug, SIDE);

    if (filled) {
        console.log(`\n✅ Order filled! You hold ${Number(balance) / 1e6} ${SIDE} contracts.`);
    } else {
        console.log('\n⏳ Order not yet filled — it may still be resting in the orderbook.');
        console.log('   Check again later, or cancel with: trading.cancelAllOrders(slug)');
    }
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
