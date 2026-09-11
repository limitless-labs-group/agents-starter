/**
 * check-balances — what the wallet holds on-chain and on Limitless.
 *
 *   npx tsx src/scripts/check-balances.ts
 *
 * Prints USDC + ETH on Base, the authenticated profile, open CLOB positions
 * (shares per side), and any resolved winnings you can claim with
 * `npm run redeem claim-all`.
 */

import dotenv from 'dotenv';
dotenv.config({ quiet: true });

import { createPublicClient, http, parseAbi, formatUnits, formatEther } from 'viem';
import { base } from 'viem/chains';
import { getWallet } from '../core/wallet.js';
import { createSdkClient } from '../core/limitless/client.js';
import { PortfolioClient } from '../core/limitless/portfolio.js';
import { RedeemClient } from '../core/limitless/redeem.js';

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as const;

async function main(): Promise<void> {
  const { account } = getWallet();
  const address = account.address;
  console.log(`Balance check for ${address}\n`);

  const publicClient = createPublicClient({ chain: base, transport: http() });
  const [usdc, eth] = await Promise.all([
    publicClient.readContract({
      address: USDC,
      abi: parseAbi(['function balanceOf(address) view returns (uint256)']),
      functionName: 'balanceOf',
      args: [address],
    }),
    publicClient.getBalance({ address }),
  ]);
  console.log(`  USDC on Base: $${formatUnits(usdc, 6)}   (order collateral)`);
  console.log(`  ETH on Base:  ${Number(formatEther(eth)).toFixed(5)}   (gas for approvals/redeem only)\n`);

  const sdk = createSdkClient();
  const portfolio = new PortfolioClient(sdk);

  try {
    const profile = await portfolio.getProfile();
    console.log(`  Profile #${profile.id} · ${profile.account} · wallet mode: ${profile.tradeWalletOption ?? 'unreported'}`);
    if (profile.tradeWalletOption === 'smartWallet') {
      console.log('  ! smartWallet mode rejects self-signed orders — run: npm start wallet-mode eoa');
    }
  } catch (e) {
    console.log(`  Profile: unavailable (${(e as Error).message}) — check LMTS_TOKEN_ID / LMTS_TOKEN_SECRET`);
    return;
  }

  const positions = await portfolio.getClobPositions();
  const open = positions.filter((p) => Number(p.tokensBalance?.yes ?? 0) + Number(p.tokensBalance?.no ?? 0) > 0);
  console.log(`\n  Open CLOB positions: ${open.length}`);
  for (const p of open.slice(0, 10)) {
    const yes = Number(p.tokensBalance?.yes ?? 0) / 1e6;
    const no = Number(p.tokensBalance?.no ?? 0) / 1e6;
    const live = p.orders?.liveOrders?.length ?? 0;
    console.log(`    - ${p.market?.title ?? p.market?.slug}  YES ${yes.toFixed(3)} / NO ${no.toFixed(3)}${live ? ` · ${live} live order(s)` : ''}`);
  }
  if (open.length > 10) console.log(`    … and ${open.length - 10} more`);

  try {
    const redeemer = new RedeemClient(sdk);
    const slugs = await redeemer.portfolioSlugs();
    const claimable = await redeemer.findClaimablePositions(slugs);
    console.log(`\n  Claimable winnings: ${claimable.length}`);
    for (const c of claimable.slice(0, 5)) console.log(`    - ${c.marketTitle}: ${c.expectedPayout}`);
    if (claimable.length) console.log('    → npm run redeem claim-all');
  } catch (e) {
    console.log(`\n  Claimable check skipped: ${(e as Error).message}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
