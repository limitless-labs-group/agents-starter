#!/usr/bin/env node
/**
 * Auto-claim script - Run hourly to claim winnings from resolved markets
 * Usage: npx tsx src/scripts/auto-claim.ts
 */

import { RedeemClient } from '../core/limitless/redeem.js';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
const posFile = path.join(dataDir, 'oracle-arb-positions.json');
const logFile = path.join(dataDir, 'auto-claim.log');

function log(msg: string) {
    const line = `[${new Date().toISOString()}] ${msg}`;
    console.log(line);
    fs.appendFileSync(logFile, line + '\n');
}

async function main() {
    log('Starting auto-claim check...');
    
    const client = new RedeemClient();
    log(`Wallet: ${client.getAddress()}`);
    
    // Load markets from local positions file
    let slugs: string[] = [];
    try {
        if (fs.existsSync(posFile)) {
            const content = fs.readFileSync(posFile, 'utf8');
            const positions = JSON.parse(content);
            slugs = Object.keys(positions);
            log(`Found ${slugs.length} markets in local positions file`);
        }
    } catch (e: any) {
        log(`Error reading positions file: ${e.message}`);
    }
    
    if (slugs.length === 0) {
        log('No markets to check');
        return;
    }
    
    // Check for claimable positions
    log(`Checking ${slugs.length} markets for claimable winnings...`);
    const claimable = await client.findClaimablePositions(slugs);

    if (claimable.length === 0) {
        log('No claimable positions found');
        return;
    }

    // Load trade log for cost basis lookup
    const tradeLogFile = path.join(dataDir, 'oracle-arb-trades.jsonl');
    const tradeLog = fs.existsSync(tradeLogFile)
        ? fs.readFileSync(tradeLogFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
        : [];

    // Load/update PnL tracker
    const pnlFile = path.join(dataDir, 'pnl-tracker.json');
    let pnlData: any = { events: [], totalPnl: 0 };
    if (fs.existsSync(pnlFile)) {
        try { pnlData = JSON.parse(fs.readFileSync(pnlFile, 'utf8')); } catch {}
    }

    let totalClaimed = 0;
    const txHashes: string[] = [];

    // Fetch nonce once and increment manually — prevents collisions when
    // multiple positions resolve simultaneously and txs fire back-to-back
    let nonce = await client.getCurrentNonce();

    for (const position of claimable) {
        const indexSet = position.winningOutcomeIndex === 0 ? 1 : 2;
        const hash = await client.redeemPositions(position.conditionId, [indexSet], nonce++);
        if (hash) {
            txHashes.push(hash);
            const claimedUsd = parseFloat(position.expectedPayout.replace(' USDC', '')) || 0;
            totalClaimed += claimedUsd;

            // Find cost basis from trade log (latest matching slug)
            const trade = [...tradeLog].reverse().find(t => t.marketSlug === position.marketSlug);
            const costBasis = trade?.amountUsd || 2; // default $2 per position
            const pnl = claimedUsd - costBasis;

            pnlData.events = pnlData.events || [];
            pnlData.events.push({
                ts: new Date().toISOString(),
                marketSlug: position.marketSlug,
                claimed: claimedUsd,
                costBasis,
                pnl,
                tx: hash,
            });
            pnlData.totalPnl = (pnlData.totalPnl || 0) + pnl;
        }
    }

    fs.writeFileSync(pnlFile, JSON.stringify(pnlData, null, 2));

    // Wait for all receipts in parallel after all txs submitted
    if (txHashes.length > 0) await client.waitForReceipts(txHashes);

    if (txHashes.length > 0) {
        log(`✅ Claimed ${txHashes.length} positions, total value: ${totalClaimed.toFixed(3)} USDC`);
        log(`Transactions: ${txHashes.join(', ')}`);
    } else {
        log('No claimable positions found');
    }
}

main().catch(e => {
    log(`ERROR: ${e.message}`);
    process.exit(1);
});
