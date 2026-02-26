/**
 * dashboard.ts — Limitless Agent Analytics Dashboard
 *
 * Serves a local web dashboard on http://localhost:3456 with:
 *   • Hero KPIs (balance, P&L, win rate, open positions, claimable)
 *   • SVG cumulative P&L chart
 *   • Open positions, open orders, trade history, claimable winnings
 *   • Server-Sent Events (SSE) for live dot + triggered refreshes
 *
 * Usage:
 *   npm run dashboard
 *   → open http://localhost:3456
 *
 * Requirements: PRIVATE_KEY + LIMITLESS_API_KEY in .env
 */

import * as dotenv from 'dotenv';
dotenv.config();

import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { LimitlessClient } from './core/limitless/markets.js';
import { PortfolioClient } from './core/limitless/portfolio.js';
import { RedeemClient }    from './core/limitless/redeem.js';
import { TradingClient }   from './core/limitless/trading.js';
import { OrderSigner }     from './core/limitless/sign.js';
import { getWallet }       from './core/wallet.js';
import { createPublicClient, http, parseAbi, formatUnits } from 'viem';
import { base } from 'viem/chains';

const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as const;

// Fallback Base RPC endpoints
const BASE_RPCS = [
    'https://mainnet.base.org',
    'https://base-rpc.publicnode.com',
    'https://base.llamarpc.com',
    'https://base.drpc.org',
];

let rpcIndex = 0;
function getNextRpc(): string {
    const url = BASE_RPCS[rpcIndex];
    rpcIndex = (rpcIndex + 1) % BASE_RPCS.length;
    return url;
}

const PORT = parseInt(process.env.DASHBOARD_PORT || '3456', 10);

const __dirname  = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC_DIR = resolve(__dirname, '..', 'public');
const HTML_FILE  = join(PUBLIC_DIR, 'dashboard.html');

// ── SDK clients ───────────────────────────────────────────────────────────────

const limitless = new LimitlessClient();
const portfolio = new PortfolioClient();

let redeemer: RedeemClient | null = null;
let trading:  TradingClient | null = null;
let walletAddress = '';

try {
    const { client: walletClient, account } = getWallet();
    walletAddress = account.address;
    const signer = new OrderSigner(walletClient, account);
    trading  = new TradingClient(limitless, signer);
    redeemer = new RedeemClient();
} catch {
    console.warn('WARNING: PRIVATE_KEY not set — trading/claiming features disabled.');
}

// ── SSE broadcast infrastructure ──────────────────────────────────────────────

const sseClients = new Set<ServerResponse>();

function sseWrite(data: object) {
    const payload = `data: ${JSON.stringify(data, (_key, value) =>
        typeof value === 'bigint' ? value.toString() : value
    )}\n\n`;
    for (const res of sseClients) {
        try {
            res.write(payload);
        } catch {
            sseClients.delete(res);
        }
    }
}

// Send a heartbeat every 15 s so the client's SSE connection stays alive
// and the dot stays green.
setInterval(() => sseWrite({ type: 'heartbeat', ts: Date.now() }), 15_000);

// Broadcast an 'update' event every 30 s so all connected tabs refresh together.
setInterval(() => sseWrite({ type: 'update', ts: Date.now() }), 30_000);

// ── Data helpers ──────────────────────────────────────────────────────────────

/**
 * Build cumulative P&L data points from an array of raw chart points
 * returned by the Limitless API, or synthesise them from trade history
 * if the chart endpoint doesn't return time-series data.
 */
function buildCumPnl(
    chartData: any,
    trades: any[],
): { ts: string; pnl: number }[] {
    // Try chart API data first (array of {time|ts, value|pnl})
    if (Array.isArray(chartData?.data) && chartData.data.length > 0) {
        let running = 0;
        return chartData.data.map((pt: any) => {
            const v = parseFloat(pt.value ?? pt.pnl ?? pt.y ?? '0') || 0;
            running += v;
            return { ts: pt.time ?? pt.ts ?? '', pnl: Math.round(running * 100) / 100 };
        });
    }

    // Fallback: synthesise from trade history using sell amounts as P&L deltas.
    // This is a rough approximation but gives a meaningful chart shape.
    // Handle both API format (Sell strategy) and oracle-arb format
    const sells = trades
        .filter(t => t.strategy === 'Sell' || t.strategy === 'oracle-arb')
        .sort((a, b) => {
            const ta = a.timestamp ?? a.createdAt ?? '';
            const tb = b.timestamp ?? b.createdAt ?? '';
            return ta < tb ? -1 : ta > tb ? 1 : 0;
        });

    if (!sells.length) {
        // Return a single point so chart isn't empty
        return [{ ts: new Date().toISOString(), pnl: 0 }];
    }

    let running = 0;
    return sells.map(t => {
        // For oracle-arb, use amount as proxy for PnL (simplified)
        const amt = parseFloat(t.tradeAmountUSD ?? t.tradeAmount ?? '0') || 0;
        const pnlDelta = t.strategy === 'oracle-arb' 
            ? (t.success ? amt * 0.1 : -amt * 0.1)  // Assume 10% edge on oracle trades
            : amt;
        running += pnlDelta;
        return { ts: t.timestamp ?? '', pnl: Math.round(running * 100) / 100 };
    });
}

/**
 * Read oracle-arb trade log from JSONL file
 */
async function readOracleArbTrades(): Promise<any[]> {
    // __dirname is src/, go up one level to agents-demo/ then into data/
    const logFile = resolve(__dirname, '..', 'data', 'oracle-arb-trades.jsonl');
    console.log('[dashboard] Looking for trades at:', logFile);
    if (!existsSync(logFile)) {
        console.log('[dashboard] Trades file not found');
        return [];
    }
    
    try {
        const content = readFileSync(logFile, 'utf8');
        const lines = content.split('\n').filter(Boolean);
        console.log('[dashboard] Loaded', lines.length, 'trades');
        return lines.map(line => JSON.parse(line));
    } catch (e: any) {
        console.error('[dashboard] Error reading trades:', e.message);
        return [];
    }
}

/**
 * Read oracle-arb positions from JSON file
 */
function readOracleArbPositions(): any[] {
    // __dirname is src/, go up one level to agents-demo/ then into data/
    const posFile = resolve(__dirname, '..', 'data', 'oracle-arb-positions.json');
    console.log('[dashboard] Looking for positions at:', posFile);
    if (!existsSync(posFile)) {
        console.log('[dashboard] Positions file not found');
        return [];
    }
    
    try {
        const content = readFileSync(posFile, 'utf8');
        const data = JSON.parse(content);
        const positions = Object.values(data);
        console.log('[dashboard] Loaded positions:', positions.length);
        return positions;
    } catch (e: any) {
        console.error('[dashboard] Error reading positions:', e.message);
        return [];
    }
}

/**
 * Fetch wallet USDC balance from chain with fallback RPCs
 */
async function fetchWalletBalance(walletAddress: string): Promise<number> {
    for (let i = 0; i < BASE_RPCS.length; i++) {
        const rpcUrl = getNextRpc();
        try {
            const publicClient = createPublicClient({
                chain: base,
                transport: http(rpcUrl),
            });

            const balance = await publicClient.readContract({
                address: USDC_ADDRESS,
                abi: parseAbi(['function balanceOf(address) view returns (uint256)']),
                functionName: 'balanceOf',
                args: [walletAddress as `0x${string}`],
            });

            const usdcBalance = parseFloat(formatUnits(balance, 6));
            console.log('[dashboard] Wallet balance:', usdcBalance, 'USDC via', rpcUrl);
            return usdcBalance;
        } catch (e: any) {
            console.warn('[dashboard] RPC failed:', rpcUrl, e.message);
        }
    }
    console.error('[dashboard] All RPCs failed for balance check');
    return 0;
}

/**
 * Compute per-market asset breakdown from trade history for the bar charts.
 * Groups by market title, counting buys as "pending" and sells as resolved.
 */
function extractAsset(slug: string): string {
    // Extract asset ticker from slug like "dollarbtc-above-..." or market title like "$BTC above ..."
    const m = slug.match(/\$(BTC|ETH|SOL|DOGE|BNB|XRP|ADA|AVAX|DOT|MATIC)/i)
           || slug.match(/dollar(btc|eth|sol|doge|bnb|xrp|ada|avax|dot|matic)/i);
    return m ? m[1].toUpperCase() : slug.slice(0, 20);
}

function buildByAsset(trades: any[]): Record<string, { wins: number; losses: number; pending: number; pnl: number }> {
    const map: Record<string, { wins: number; losses: number; pending: number; pnl: number }> = {};

    for (const t of trades) {
        const raw = t.marketTitle || t.marketSlug || t.market?.title || t.marketId || 'Unknown';
        const key = extractAsset(raw);
        if (!map[key]) map[key] = { wins: 0, losses: 0, pending: 0, pnl: 0 };
        const a = map[key];
        const amt = parseFloat(t.tradeAmountUSD ?? t.tradeAmount ?? '0') || 0;
        
        // wins = filled FOK orders, losses = missed FOK orders
        // Note: "wins" here means "filled", not "resolved profitably"
        const filled = t.filled || t.success === true;
        if (filled) {
            a.wins++;
            a.pnl += amt;
        } else {
            a.losses++;
        }
        a.pnl = Math.round(a.pnl * 100) / 100;
    }

    return map;
}

// ── Main data aggregation ─────────────────────────────────────────────────────

async function fetchDashboardData(): Promise<object> {
    const results: Record<string, any> = {
        wallet:    walletAddress || null,
        balance:   null,
        totalPnl:  0,
        winRate:   null,
        wins:      0,
        losses:    0,
        pnlSource: '',
        cumPnl:    [],
        byAsset:   {},
        positions: [],
        orders:    [],
        trades:    [],
        claimable: [],
        overview:  {},
        strategyConfig: {},
    };

    // ── Strategy Config (from env) ───────────────────────────────────────────
    results.strategyConfig = {
        mode: process.env.DRY_RUN === 'false' ? 'LIVE' : 'DRY RUN',
        assets: process.env.ORACLE_ASSETS || 'BTC,ETH,SOL',
        betSize: '$' + (process.env.ORACLE_BET_SIZE || '2'),
        minEdge: (parseFloat(process.env.ORACLE_MIN_EDGE || '0.15') * 100).toFixed(0) + '%',
        maxPrice: (parseFloat(process.env.ORACLE_MAX_PRICE || '0.70') * 100).toFixed(0) + '¢',
        confidence: (parseFloat(process.env.ORACLE_MIN_CONFIDENCE || '0.75') * 100).toFixed(0) + '%',
        maxPositions: process.env.ORACLE_MAX_POSITIONS || '10',
        expiry: (process.env.ORACLE_MIN_MINUTES || '0') + '-' + (process.env.ORACLE_MAX_MINUTES || '90') + 'min',
    };

    // ── Positions ────────────────────────────────────────────────────────────
    try {
        const raw = await portfolio.getPositions();
        console.log('[dashboard] Raw positions:', raw ? (Array.isArray(raw) ? raw.length : Object.keys(raw)) : 'null');
        const positions: any[] = Array.isArray(raw)
            ? raw
            : [
                ...((raw as any).clob  ?? []),
                ...((raw as any).amm   ?? []),
                ...((raw as any).group ?? []),
              ];
        console.log('[dashboard] Processed positions count:', positions.length);

        // Fallback to local positions file if API returns empty
        if (positions.length === 0) {
            const localPositions = readOracleArbPositions();
            results.positions = localPositions.map((p: any) => ({
                marketTitle: p.marketSlug,
                marketSlug: p.marketSlug,
                side: p.side,
                size: p.amountUsd,
                fillPrice: Math.round(p.entryPrice * 100),
                currentPrice: null,
                unrealizedPnl: null,
            }));
        } else {
            results.positions = positions.map((p: any) => {
            const hasYes = p.positions?.yes || p.yes;
            const hasNo  = p.positions?.no  || p.no;
            const side   = hasYes ? 'YES' : hasNo ? 'NO' : null;
            const sideData = side === 'YES'
                ? (p.positions?.yes ?? p.yes)
                : (p.positions?.no  ?? p.no);

            // Debug: log raw values
            if (sideData?.fillPrice) {
                console.log('[dashboard] Raw fillPrice:', sideData.fillPrice, 'type:', typeof sideData.fillPrice);
            }

            // Prices - API may return in different formats (0-1 decimal, or already scaled)
            const fillPriceRaw    = sideData?.fillPrice    ?? null;
            const currentPriceRaw = sideData?.currentPrice ?? fillPriceRaw;
            
            // Smart price conversion: if value > 100, assume it's already in cents/scaled format
            const parsePrice = (val: any): number | null => {
                if (val == null) return null;
                const num = parseFloat(val);
                if (isNaN(num)) return null;
                // If already > 100, it's likely already in cents or micro-units
                if (num > 100) {
                    // If it's > 10000, assume micro-USDC (divide by 10000 to get cents)
                    if (num > 10000) return Math.round(num / 10000);
                    return Math.round(num); // Already in cents
                }
                return Math.round(num * 100); // Convert 0-1 to cents
            };
            
            const fillPrice    = parsePrice(fillPriceRaw);
            const currentPrice = parsePrice(currentPriceRaw);

            // size is in micro-USDC, convert to USD
            const sizeRaw = sideData?.marketValue ?? sideData?.collateralAmount ?? null;
            const sizeUsd = sizeRaw ? parseFloat(sizeRaw) / 1_000_000 : null;

            return {
                marketTitle:   p.market?.title   ?? p.marketTitle ?? 'Unknown',
                marketSlug:    p.market?.slug     ?? p.marketSlug  ?? '',
                side,
                size:          sizeUsd,
                fillPrice,
                currentPrice,
                unrealizedPnl: sideData?.unrealizedPnl ?? null,
            };
            });
        }
    } catch (e: any) {
        console.error('[dashboard] positions error:', e.message);
    }

    // ── Trade history ────────────────────────────────────────────────────────
    let apiTradesFailed = false;
    try {
        const trades = await portfolio.getTrades();
        results.trades = Array.isArray(trades) ? trades : [];
    } catch (e: any) {
        console.error('[dashboard] trades error:', e.message);
        apiTradesFailed = true;
        results.trades = [];
    }

    // ── Oracle Arb trade log (fallback when portfolio trades empty or fails) ───────────
    // NOTE: These are PLACED orders, not necessarily filled. GTC orders at 55¢ may not fill.
    // Only claimed positions are verified as "real" profits.
    try {
        const oracleTrades = await readOracleArbTrades();
        if (oracleTrades.length > 0 && (results.trades.length === 0 || apiTradesFailed)) {
            results.trades = oracleTrades.map((t: any) => ({
                marketId: t.marketSlug,
                marketTitle: t.marketSlug,
                marketSlug: t.marketSlug,
                strategy: 'oracle-arb',
                side: t.side,
                tradeAmountUSD: t.amountUsd,
                amountUsd: t.amountUsd,
                edgePercent: t.edgePercent ?? t.edge ?? null,
                timestamp: new Date(t.timestamp).toISOString(),
                success: t.success,
                filled: t.success === true,
                filledAmount: t.success ? t.amountUsd : 0,
                status: 'FOK',
            }));
        }
    } catch (e: any) {
        console.error('[dashboard] oracle trades error:', e.message);
    }

    // ── PnL calculation ─────────────────────────────────────────────────────
    // Use pnl-tracker events written by auto-claim (claimed - costBasis)
    let realizedPnl = 0;
    let winningPositions = 0;
    let pnlEvents: any[] = [];
    try {
        const pnlFile = resolve(__dirname, '..', 'data', 'pnl-tracker.json');
        if (existsSync(pnlFile)) {
            const pnlData = JSON.parse(readFileSync(pnlFile, 'utf8'));
            pnlEvents = pnlData.events || [];
            realizedPnl = pnlData.totalPnl || 0;
            winningPositions = pnlEvents.length;
        }
    } catch { 
        realizedPnl = 0;
    }
    
    let chartRaw: any = null;
    try {
        chartRaw = await portfolio.getPnlChart('all');
        if (chartRaw?.totalPnl != null) {
            results.totalPnl = parseFloat(chartRaw.totalPnl) || 0;
        }
        // Override with realized P&L if we have position data
        if (realizedPnl > 0 && results.totalPnl === 0) {
            results.totalPnl = realizedPnl;
        }
        if (chartRaw?.winRate != null) {
            // API may return 0-1 or 0-100 range
            const wr = parseFloat(chartRaw.winRate);
            results.winRate = wr <= 1 ? wr * 100 : wr;
        }
    } catch {
        // Use realized P&L as fallback
        results.totalPnl = realizedPnl;
    }

    // Build cumulative P&L data for chart - use pnl tracker events if available
    if (pnlEvents.length > 0) {
        let running = 0;
        results.cumPnl = pnlEvents.map((e: any) => {
            running += (e.pnl || 0);
            return { ts: e.ts, pnl: Math.round(running * 100) / 100 };
        });
    } else {
        // Fallback to trade-based chart
        results.cumPnl = buildCumPnl(chartRaw, results.trades);
    }

    // Calculate win rate from actual claimed positions only
    // GTC orders at 55¢ don't count until claimed
    if (results.winRate === null || results.winRate === 100) {
        const totalAttempted = results.trades.length;
        if (winningPositions > 0 && totalAttempted > 0) {
            results.winRate = Math.round((winningPositions / totalAttempted) * 1000) / 10;
        } else {
            results.winRate = 0;
        }
    }

    // Populate wins/losses for frontend
    if (pnlEvents.length > 0) {
        results.wins = pnlEvents.filter((e: any) => (e.pnl || 0) > 0).length;
        results.losses = pnlEvents.filter((e: any) => (e.pnl || 0) <= 0).length;
        results.pnlSource = 'from claimed positions';
    } else {
        // Fallback: count from trades
        const filled = results.trades.filter((t: any) => t.filled || t.success);
        results.wins = filled.length;
        results.losses = results.trades.length - filled.length;
        results.pnlSource = results.trades.length ? 'from trade log' : '';
    }

    // Per-asset breakdown
    results.byAsset = buildByAsset(results.trades);

    // ── Open orders (from each known market slug) ────────────────────────────
    const knownSlugs = results.positions.map((p: any) => p.marketSlug).filter(Boolean);
    const openOrders: any[] = [];

    if (trading && knownSlugs.length > 0) {
        await Promise.all(
            knownSlugs.map(async (slug: string) => {
                try {
                    const orders = await trading!.getUserOrders(slug, 'OPEN');
                    const mapped = (Array.isArray(orders) ? orders : []).map((o: any) => ({
                        marketSlug:  slug,
                        marketTitle: results.positions.find((p: any) => p.marketSlug === slug)?.marketTitle ?? slug,
                        side:        o.side || o.outcome || '—',
                        // Price is 0-1 decimal, convert to cents (0.55 -> 55)
                        price:       o.price != null ? Math.round(parseFloat(o.price) * 100) : null,
                        // makerAmount is in micro-USDC (1_000_000 = $1)
                        size:        o.size ?? (o.makerAmount ? parseFloat(o.makerAmount) / 1_000_000 : null),
                        status:      o.status ?? 'LIVE',
                        timestamp:   o.createdAt ?? o.timestamp ?? null,
                    }));
                    openOrders.push(...mapped);
                } catch { /* skip */ }
            })
        );
    }
    results.orders = openOrders;

    // ── Claimable winnings ───────────────────────────────────────────────────
    // Use ONLY local positions file for consistent results (API positions change too frequently)
    const tradedSlugs = new Set<string>();
    
    try {
        const localPositions = readOracleArbPositions();
        localPositions.forEach((p: any) => {
            if (p.marketSlug) tradedSlugs.add(p.marketSlug);
        });
        console.log('[dashboard] Loaded', tradedSlugs.size, 'markets from local positions file');
    } catch { /* ignore */ }
    
    if (redeemer && tradedSlugs.size > 0) {
        try {
            const slugs = [...tradedSlugs] as string[];
            // Add timeout to prevent blocking the dashboard (max 10s for claimable check)
            const timeout = (ms: number) => new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), ms));
            results.claimable = await Promise.race([
                redeemer.findClaimablePositions(slugs),
                timeout(10000)
            ]) as any[];
            console.log('[dashboard] Found', results.claimable.length, 'claimable positions');
        } catch (e: any) {
            console.error('[dashboard] claimable error:', e.message);
            results.claimable = [];
        }
    }

    // ── Balance (wallet + positions) ─────────────────────────────────────────
    // Fetch actual wallet USDC balance from chain
    let walletBalance = 0;
    if (walletAddress) {
        try {
            walletBalance = await fetchWalletBalance(walletAddress);
        } catch (e: any) {
            console.error('[dashboard] Error fetching wallet balance:', e.message);
        }
    }
    
    // Position value from API positions
    const positionValue = results.positions.reduce((s: number, p: any) => {
        return s + (parseFloat(p.size ?? '0') || 0);
    }, 0);
    
    // Total equity = wallet balance + position value
    results.balance = Math.round((walletBalance + positionValue) * 100) / 100;
    results.walletBalance = Math.round(walletBalance * 100) / 100;
    results.positionValue = Math.round(positionValue * 100) / 100;

    // ── Consolidated overview block (mirrors old shape for compat) ───────────
    results.overview = {
        wallet:         walletAddress || null,
        balance:        results.balance,
        pnl:            results.totalPnl,
        winRate:        results.winRate,
        positionCount:  results.positions.length,
        orderCount:     results.orders.length,
        claimableCount: results.claimable.length,
    };

    return results;
}

// ── HTTP server ───────────────────────────────────────────────────────────────

function sendJson(res: ServerResponse, data: object, status = 200) {
    const body = JSON.stringify(data, (_key, value) =>
        typeof value === 'bigint' ? value.toString() : value
    );
    res.writeHead(status, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
    });
    res.end(body);
}

function sendError(res: ServerResponse, msg: string, status = 500) {
    sendJson(res, { ok: false, error: msg }, status);
}

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? '/';

    // ── Serve dashboard HTML ─────────────────────────────────────────────────
    if (url === '/' || url === '/index.html') {
        if (!existsSync(HTML_FILE)) {
            res.writeHead(404); res.end('dashboard.html not found');
            return;
        }
        const html = readFileSync(HTML_FILE, 'utf-8');
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(html);
        return;
    }

    // ── SSE live events ──────────────────────────────────────────────────────
    if (url === '/api/events') {
        res.writeHead(200, {
            'Content-Type':  'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection':    'keep-alive',
            'Access-Control-Allow-Origin': '*',
        });
        res.write(`data: ${JSON.stringify({ type: 'connected', ts: Date.now() })}\n\n`);
        sseClients.add(res);
        req.on('close', () => sseClients.delete(res));
        return;
    }

    // ── Aggregate data endpoint ──────────────────────────────────────────────
    if (url === '/api/dashboard') {
        try {
            const data = await fetchDashboardData();
            sendJson(res, data);
        } catch (e: any) {
            sendError(res, e.message);
        }
        return;
    }

    // ── Claim: POST /api/claim/:slug ─────────────────────────────────────────
    const claimMatch = url.match(/^\/api\/claim\/(.+)$/);
    if (claimMatch && req.method === 'POST') {
        const slug = decodeURIComponent(claimMatch[1]);
        if (!redeemer) { sendError(res, 'PRIVATE_KEY not configured', 400); return; }
        try {
            const tx = await redeemer.redeemSingle(slug);
            sendJson(res, { ok: true, tx });
            // Trigger a refresh for connected browsers after a successful claim
            if (tx) sseWrite({ type: 'update', ts: Date.now() });
        } catch (e: any) {
            sendError(res, e.message);
        }
        return;
    }

    res.writeHead(404); res.end('Not found');
});

// ── Start ─────────────────────────────────────────────────────────────────────

server.listen(PORT, '127.0.0.1', () => {
    console.log('\nLimitless Agent Dashboard');
    console.log(`   → http://localhost:${PORT}\n`);
    console.log('   SSE live updates every 30 s. Press Ctrl+C to stop.\n');
    if (!walletAddress) {
        console.warn('   WARNING: No PRIVATE_KEY set — order & claim endpoints disabled.\n');
    }
});

server.on('error', (err: any) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`\nERROR: Port ${PORT} already in use. Set DASHBOARD_PORT= to override.\n`);
    } else {
        console.error('\nERROR: Server error:', err.message);
    }
    process.exit(1);
});
