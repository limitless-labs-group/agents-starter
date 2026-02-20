import { WalletClient, LocalAccount, getAddress, Hex } from 'viem';
import { EIP712_DOMAIN, EIP712_TYPES, Order, SignedOrder, MarketVenue } from './types.js';
import { pino } from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

export class OrderSigner {
    constructor(
        private wallet: WalletClient,
        private account: LocalAccount,
        private chainId: number = 8453
    ) { }
    
    getAddress(): string {
        return this.account.address;
    }

    async signOrder(
        marketVenue: MarketVenue,
        orderParams: {
            tokenId: string;
            makerAmount: bigint; // Raw units (wei)
            takerAmount: bigint; // Raw units (wei)
            side: 'BUY' | 'SELL';
            expiration?: number; // 0 or timestamp in ms
            feeRateBps?: number;
            nonce?: number;
        }
    ): Promise<SignedOrder> {
        const { exchange } = marketVenue;

        // Safety check: ensure addresses are checksummed. Viem's getAddress does this.
        const maker = getAddress(this.account.address);
        const signer = getAddress(this.account.address);
        const taker = '0x0000000000000000000000000000000000000000'; // Open order

        // Default values - feeRateBps should match user's band (300 = 3% for Bronze)
        const expiration = orderParams.expiration ? BigInt(orderParams.expiration) : 0n;
        const salt = BigInt(Date.now() + 86400000); // 24h from now
        const nonce = BigInt(orderParams.nonce || 0);
        const feeRateBps = BigInt(orderParams.feeRateBps || 300); // Default to Bronze tier fee

        // Side: 0 = BUY, 1 = SELL (Limitless specific enum)
        // Actually, prompt says: "side: 0 = BUY, 1 = SELL"
        const sideIdx = orderParams.side === 'BUY' ? 0 : 1;
        const signatureType = 0; // EOA

        const domain = {
            ...EIP712_DOMAIN,
            chainId: this.chainId,
            verifyingContract: getAddress(exchange),
        };

        const message = {
            salt,
            maker,
            signer,
            taker,
            tokenId: BigInt(orderParams.tokenId),
            makerAmount: orderParams.makerAmount,
            takerAmount: orderParams.takerAmount,
            expiration,
            nonce,
            feeRateBps,
            side: sideIdx,
            signatureType,
        };

        logger.debug({ domain, message }, 'Signing order');

        const signature = await this.wallet.signTypedData({
            account: this.account,
            domain,
            types: EIP712_TYPES,
            primaryType: 'Order',
            message: message as any, // Viem type inference can be tricky with dynamic BigInts
        });

        return {
            salt: salt.toString(),
            maker,
            signer,
            taker,
            tokenId: orderParams.tokenId,
            makerAmount: orderParams.makerAmount.toString(),
            takerAmount: orderParams.takerAmount.toString(),
            expiration: expiration.toString(),
            nonce: Number(nonce),
            feeRateBps: Number(feeRateBps),
            side: sideIdx as 0 | 1,
            signatureType,
            signature,
        };
    }
}
