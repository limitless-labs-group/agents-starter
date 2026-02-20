
import { createPublicClient, http, getContract, parseAbi, maxUint256, PublicClient, WalletClient } from 'viem';
import { base } from 'viem/chains';
import { getWallet } from '../wallet.js';
import { LimitlessClient } from './markets.js';
import { pino } from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

// Base Mainnet Addresses
const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
// Base chain CTF (NOT Polygon/Polymarket address)
const CTF_ADDRESS = '0xC9c98965297Bc527861c898329Ee280632B76e18';

// ABIs
const ERC20_ABI = parseAbi([
    'function approve(address spender, uint256 amount) external returns (bool)',
    'function allowance(address owner, address spender) external view returns (uint256)'
]);

const CTF_ABI = parseAbi([
    'function setApprovalForAll(address operator, bool approved) external',
    'function isApprovedForAll(address owner, address operator) external view returns (bool)'
]);

/**
 * Approves tokens for a specific market's venue.
 * @param marketSlug The slug of the market to approve for.
 */
export async function approveMarketVenue(marketSlug: string) {
    const { client: walletClient, account } = getWallet();

    // Create public client for reading state
    const publicClient = createPublicClient({
        chain: base,
        transport: http()
    });

    const limitlessClient = new LimitlessClient();

    logger.info({ marketSlug }, 'Fetching market details for approval...');
    const market = await limitlessClient.getMarket(marketSlug);

    if (!market.venue || !market.venue.exchange) {
        logger.error(`Market ${marketSlug} has no venue/exchange data.`);
        throw new Error(`Market ${marketSlug} has no venue/exchange data.`);
    }

    const exchangeAddress = market.venue.exchange as `0x${string}`;
    const adapterAddress = market.venue.adapter ? market.venue.adapter as `0x${string}` : undefined;

    logger.info({ exchange: exchangeAddress, adapter: adapterAddress }, 'Found venue addresses');

    // 1. Approve USDC for Exchange (Required for BUY)
    await approveUsdc(publicClient, walletClient, account.address, exchangeAddress);

    // 2. Approve CTF for Exchange (Required for SELL)
    try {
        // @ts-ignore
        await approveCtf(publicClient, walletClient, account.address, exchangeAddress);
    } catch (e) {
        logger.warn({ error: e }, 'Failed to approve CTF for Exchange. SELL orders might fail if not already approved.');
    }

    // 3. Approve CTF for Adapter (Required for SELL on NegRisk/Group markets)
    if (adapterAddress) {
        try {
            // @ts-ignore
            await approveCtf(publicClient, walletClient, account.address, adapterAddress);
        } catch (e) {
            logger.warn({ error: e }, 'Failed to approve CTF for Adapter.');
        }
    }

    logger.info('✅ All approvals complete!');
}

async function approveUsdc(publicClient: any, walletClient: any, owner: `0x${string}`, spender: `0x${string}`) {
    const usdc = getContract({
        address: USDC_ADDRESS,
        abi: ERC20_ABI,
        client: { public: publicClient, wallet: walletClient }
    });

    // @ts-ignore
    const allowance = await usdc.read.allowance([owner, spender]);
    // Check if allowance is sufficient (e.g. > 1M USDC)
    const minAllowance = 1_000_000_000000n; // 1M USDC

    if (allowance < minAllowance) {
        logger.info({ spender, currentAllowance: allowance.toString() }, 'Approving USDC...');
        // @ts-ignore
        const hash = await usdc.write.approve([spender, maxUint256]);
        logger.info({ hash }, 'USDC Approval Tx Sent');
        await publicClient.waitForTransactionReceipt({ hash });
        logger.info('USDC Approval Confirmed');
    } else {
        logger.info({ spender }, 'USDC already approved');
    }
}

async function approveCtf(publicClient: any, walletClient: any, owner: `0x${string}`, operator: `0x${string}`) {
    const ctf = getContract({
        address: CTF_ADDRESS,
        abi: CTF_ABI,
        client: { public: publicClient, wallet: walletClient }
    });

    // @ts-ignore
    const isApproved = await ctf.read.isApprovedForAll([owner, operator]);

    if (!isApproved) {
        logger.info({ operator }, 'Approving Conditional Tokens (CTF)...');
        // @ts-ignore
        const hash = await ctf.write.setApprovalForAll([operator, true]);
        logger.info({ hash }, 'CTF Approval Tx Sent');
        await publicClient.waitForTransactionReceipt({ hash });
        logger.info('CTF Approval Confirmed');
    } else {
        logger.info({ operator }, 'CTF already approved');
    }
}
