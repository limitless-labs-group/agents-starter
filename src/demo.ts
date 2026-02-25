/**
 * demo.ts — Limitless Agents Starter Kit: Demo Mode
 *
 * Runs a safe end-to-end walkthrough with DRY_RUN=true (no real trades):
 *  1. Searches for a live hourly (lumy) market
 *  2. Shows market details: title, YES/NO prices, slug
 *  3. Signs and previews an order without submitting it
 *  4. Checks your portfolio for existing positions
 *  5. Checks for any claimable winnings in resolved markets
 *  6. Prints a summary
 *
 * Requirements: PRIVATE_KEY + LIMITLESS_API_KEY in .env (or environment).
 *
 * Usage:
 *   npm run demo
 */

import * as dotenv from 'dotenv';
dotenv.config();

// Force dry-run — the demo never submits real orders
process.env.DRY_RUN = 'true';

import { getWallet } from './core/wallet.js';
import { LimitlessClient } from './core/limitless/markets.js';
import { OrderSigner } from './core/limitless/sign.js';
import { TradingClient } from './core/limitless/trading.js';
import { PortfolioClient } from './core/limitless/portfolio.js';
import { RedeemClient } from './core/limitless/redeem.js';

// ─── helpers ───────────────────────────────────────────────────────────────

const hr = () => console.log('\n' + '─'.repeat(60));

function fmt(n: number | string, decimals = 1): string {
    return Number(n).toFixed(decimals);
}

// ─── main ──────────────────────────────────────────────────────────────────

async function main() {
    console.log('\n🚀 Limitless Agents Starter — Demo Mode (DRY_RUN=true)\n');
    console.log('   All orders are previewed only — nothing is submitted.\n');

    const summary: string[] = [];

    // ── 1. Connect wallet ───────────────────────────────────────────────────
    const { client: walletClient, account } = getWallet();
    const walletAddress = account.address;
    console.log(`🔑 Wallet: ${walletAddress}`);
    summary.push(`Wallet: ${walletAddress}`);

    // ── 2. Initialise SDK clients ───────────────────────────────────────────
    const limitless = new LimitlessClient();
    const signer    = new OrderSigner(walletClient, account);
    const trading   = new TradingClient(limitless, signer);
    const portfolio = new PortfolioClient();
    const redeemer  = new RedeemClient();

    // ── 3. Find a live hourly (lumy) market ─────────────────────────────────
    hr();
    console.log('\n🔍 Searching for live hourly (lumy) markets...\n');

    // Try several assets in order until we find an active hourly market
    const ASSETS = ['BTC', 'ETH', 'SOL', 'BNB', 'DOGE'];
    let targetMarket: any = null;

    for (const asset of ASSETS) {
        const hourly = await limitless.searchHourlyMarkets(asset);
        if (hourly.length > 0) {
            // Pick the one expiring soonest
            hourly.sort((a: any, b: any) => a.expirationTimestamp - b.expirationTimestamp);
            targetMarket = hourly[0];
            console.log(`   Found ${hourly.length} hourly market(s) for ${asset} — using the first.`);
            break;
        }
    }

    if (!targetMarket) {
        // Fallback: grab any active CLOB market
        console.log('   No hourly markets found right now — falling back to any active market.');
        const markets = await limitless.getActiveMarkets({ tradeType: 'clob', limit: 5 });
        if (markets.length === 0) {
            console.error('ERROR: No active markets found. Check LIMITLESS_API_KEY and connectivity.');
            process.exit(1);
        }
        targetMarket = markets[0];
        summary.push('(No live hourly market found — used first active CLOB market as fallback)');
    }

    // ── 4. Show market details ───────────────────────────────────────────────
    hr();
    console.log('\n Market Details\n');

    const yesPrice = targetMarket.prices?.[0] ?? 50;
    const noPrice  = targetMarket.prices?.[1] ?? 50;
    const expiresIn = targetMarket.expirationTimestamp
        ? Math.round((targetMarket.expirationTimestamp - Date.now()) / 60_000)
        : null;

    console.log(`   Title    : ${targetMarket.title}`);
    console.log(`   Slug     : ${targetMarket.slug}`);
    console.log(`   YES price: ${fmt(yesPrice)}¢`);
    console.log(`   NO price : ${fmt(noPrice)}¢`);
    console.log(`   Sum      : ${fmt(yesPrice + noPrice)}¢  (< 100 = arb opportunity)`);
    if (expiresIn !== null) {
        console.log(`   Expires  : ~${expiresIn} minutes from now`);
    }
    console.log(`   Trade type: ${targetMarket.tradeType}`);

    summary.push(`Market: ${targetMarket.title} (${targetMarket.slug})`);
    summary.push(`YES: ${fmt(yesPrice)}¢  NO: ${fmt(noPrice)}¢`);

    // ── 5. Preview an order (DRY_RUN) ───────────────────────────────────────
    hr();
    console.log('\n📝 Previewing Order (DRY_RUN — no real submission)\n');

    const BET_USD   = 2;
    const SIDE: 'YES' | 'NO' = yesPrice < 50 ? 'YES' : 'NO'; // buy the cheaper side
    const PRICE_CENTS = SIDE === 'YES' ? Math.round(yesPrice) : Math.round(noPrice);

    console.log(`   Would BUY ${SIDE} @ ${PRICE_CENTS}¢  for $${BET_USD}  on  ${targetMarket.slug}`);

    let orderResult: any;
    try {
        orderResult = await trading.createOrder({
            marketSlug   : targetMarket.slug,
            side         : SIDE,
            limitPriceCents: PRICE_CENTS,
            usdAmount    : BET_USD,
            orderType    : 'GTC',
        });
        console.log('\n   Signed order (would be submitted):');
        console.log('  ', JSON.stringify(orderResult, null, 2).split('\n').join('\n   '));
        summary.push(`Demo order signed: BUY ${SIDE} @ ${PRICE_CENTS}¢ for $${BET_USD} [DRY_RUN — not submitted]`);
    } catch (err: any) {
        console.log(`   WARNING:  Could not sign order: ${err.message}`);
        summary.push(`Demo order skipped: ${err.message}`);
    }

    // ── 6. Check portfolio ───────────────────────────────────────────────────
    hr();
    console.log('\n💼 Portfolio — Existing Positions\n');

    let openPositions = 0;
    try {
        const raw = await portfolio.getPositions();
        const positions: any[] = Array.isArray(raw)
            ? raw
            : [
                ...((raw as any).clob  ?? []),
                ...((raw as any).amm   ?? []),
                ...((raw as any).group ?? []),
            ];

        if (positions.length === 0) {
            console.log('   No open positions found.');
        } else {
            openPositions = positions.length;
            positions.slice(0, 10).forEach((p: any, i: number) => {
                const title = p.market?.title ?? p.marketTitle ?? 'Unknown market';
                const slug  = p.market?.slug  ?? p.marketSlug  ?? '';
                const yesVal = p.positions?.yes?.marketValue ?? p.yes?.marketValue ?? null;
                const noVal  = p.positions?.no?.marketValue  ?? p.no?.marketValue  ?? null;
                console.log(`   [${i + 1}] ${title}`);
                if (yesVal) console.log(`        YES value: $${fmt(yesVal)}`);
                if (noVal)  console.log(`        NO  value: $${fmt(noVal)}`);
                if (slug)   console.log(`        Slug: ${slug}`);
            });
            if (positions.length > 10) {
                console.log(`   ... and ${positions.length - 10} more.`);
            }
        }
        summary.push(`Open positions: ${openPositions}`);
    } catch (err: any) {
        console.log(`   WARNING:  Could not fetch portfolio: ${err.message}`);
        summary.push('Portfolio: could not fetch');
    }

    // ── 7. Check claimable winnings ──────────────────────────────────────────
    hr();
    console.log('\n🏆 Claimable Winnings\n');

    let claimableCount = 0;
    try {
        // Fetch all portfolio positions and look for resolved markets
        const posHeaders: Record<string, string> = {
            'Content-Type': 'application/json',
            ...(process.env.LIMITLESS_API_KEY ? { 'X-API-Key': process.env.LIMITLESS_API_KEY } : {}),
        };
        const posRes = await fetch('https://api.limitless.exchange/portfolio/positions', { headers: posHeaders });
        if (!posRes.ok) throw new Error(`Portfolio API: ${posRes.status}`);

        const rawPos = await posRes.json();
        const positions: any[] = Array.isArray(rawPos)
            ? rawPos
            : [
                ...((rawPos as any).clob  ?? []),
                ...((rawPos as any).amm   ?? []),
                ...((rawPos as any).group ?? []),
            ];

        const slugs = [...new Set(positions.map((p: any) => p.market?.slug ?? p.marketSlug).filter(Boolean))] as string[];

        if (slugs.length === 0) {
            console.log('   No portfolio markets to check for winnings.');
        } else {
            console.log(`   Checking ${slugs.length} portfolio markets for claimable winnings...`);
            const claimable = await redeemer.findClaimablePositions(slugs);
            claimableCount = claimable.length;

            if (claimable.length === 0) {
                console.log('   No claimable winnings found.');
            } else {
                claimable.forEach((pos, i) => {
                    console.log(`   [${i + 1}] ${pos.marketTitle}`);
                    console.log(`        Side: ${pos.side}  |  Payout: ${pos.expectedPayout}`);
                });
                console.log(`\n   → Run: npm run redeem claim-all  to claim everything automatically.`);
            }
        }
        summary.push(`Claimable winnings: ${claimableCount} position(s)`);
    } catch (err: any) {
        console.log(`   WARNING:  Could not check winnings: ${err.message}`);
        summary.push('Claimable winnings: could not check');
    }

    // ── 8. Summary ──────────────────────────────────────────────────────────
    hr();
    console.log('\nSUCCESS: Demo Summary\n');
    summary.forEach(line => console.log(`   • ${line}`));

    console.log('\n📖 Next Steps:');
    console.log('   npm start signal-sniper         — run the momentum strategy (DRY_RUN=true)');
    console.log('   npm start approve <market-slug>  — approve a market before live trading');
    console.log('   npm run dashboard                — open the analytics dashboard');
    console.log('   npm run redeem claim-all         — claim all resolved winnings\n');
}

main().catch(err => {
    console.error('\nERROR: Demo failed:', err.message);
    process.exit(1);
});
