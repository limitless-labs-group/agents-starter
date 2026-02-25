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
    const result = await client.claimAll(slugs);
    
    if (result.claimed > 0) {
        log(`✅ Claimed ${result.claimed} positions, total value: ${result.totalValue} USDC`);
        log(`Transactions: ${result.txHashes.join(', ')}`);
    } else {
        log('No claimable positions found');
    }
}

main().catch(e => {
    log(`ERROR: ${e.message}`);
    process.exit(1);
});
