import { config } from 'dotenv';
config();
import { getWallet } from '../core/wallet.js';
import { createPublicClient, http, parseAbi, formatUnits } from 'viem';
import { base } from 'viem/chains';
import { LimitlessClient } from '../core/limitless/markets.js';

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as const;

async function main() {
  const { account } = getWallet();
  const address = account.address;

  console.log('🔍 Balance Check for:', address);
  console.log();

  // 1. Wallet balance (on-chain USDC)
  const publicClient = createPublicClient({ chain: base, transport: http() });
  const walletBalance = await publicClient.readContract({
    address: USDC,
    abi: parseAbi(['function balanceOf(address) view returns (uint256)']),
    functionName: 'balanceOf',
    args: [address],
  });
  console.log('1️⃣  Wallet USDC (on-chain): $' + formatUnits(walletBalance, 6));
  console.log('    → This is USDC in your wallet, not yet deposited to Limitless');
  console.log();

  // 2. Limitless portfolio balance
  const limitless = new LimitlessClient();
  try {
    const profileRes = await fetch(`https://api.limitless.exchange/profiles/${address}`, {
      headers: { 'X-API-Key': process.env.LIMITLESS_API_KEY || '' }
    });
    if (profileRes.ok) {
      const profile = await profileRes.json();
      console.log('2️⃣  Limitless Portfolio Balance: $' + (profile.balance || 0));
      console.log('    → This is USDC deposited and available for trading');
      console.log('    Portfolio ID:', profile.id);
    } else {
      console.log('2️⃣  Limitless Portfolio: Not created yet (status ' + profileRes.status + ')');
      console.log('    → You need to deposit USDC to create a portfolio');
    }
  } catch(e: any) {
    console.log('2️⃣  Limitless Portfolio: Error -', e.message);
  }
  console.log();

  // 3. Positions (could have unclaimed winnings)
  try {
    // Try the positions endpoint first
    const positionsRes = await fetch(`https://api.limitless.exchange/positions/${address}`, {
      headers: { 'X-API-Key': process.env.LIMITLESS_API_KEY || '' }
    });
    if (positionsRes.ok) {
      const positions = await positionsRes.json();
      const openPositions = positions.filter((p: any) => p.status === 'OPEN');
      console.log('3️⃣  Open Positions:', openPositions.length);
      if (openPositions.length > 0) {
        for (const pos of openPositions.slice(0, 5)) {
          const size = formatUnits(BigInt(pos.collateralAmount || 0), 6);
          console.log('    - ' + (pos.market?.title || pos.marketSlug));
          console.log('      Side: ' + pos.side + ' | Size: $' + size);
        }
      } else {
        console.log('    → No open positions');
      }
    } else {
      console.log('3️⃣  Open Positions: None (new account)');
    }
  } catch(e: any) {
    console.log('3️⃣  Positions: Error -', e.message);
  }
  console.log();

  // 4. Check for claimable winnings
  try {
    const eventsRes = await fetch(`https://api.limitless.exchange/portfolio/${address}/history`, {
      headers: { 'X-API-Key': process.env.LIMITLESS_API_KEY || '' }
    });
    if (eventsRes.ok) {
      const events = await eventsRes.json();
      const claimable = events.filter((e: any) => e.type === 'RESOLVED' && !e.claimed);
      console.log('4️⃣  Claimable Winnings:', claimable.length + ' markets');
      if (claimable.length > 0) {
        for (const win of claimable.slice(0, 3)) {
          console.log('    - ' + win.market?.title + ': $' + formatUnits(BigInt(win.amount || 0), 6));
        }
        console.log('    → Run: npm run redeem claim-all');
      } else {
        console.log('    → No unclaimed winnings');
      }
    }
  } catch(e: any) {
    console.log('4️⃣  Winnings check: Error -', e.message);
  }
}

main().catch(console.error);
