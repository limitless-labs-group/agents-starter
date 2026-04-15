export interface Token {
    address: string;
    decimals: number;
    symbol: string;
}

export interface MarketVenue {
    exchange: string; // The verifyingContract for EIP-712
    adapter: string;
}

export interface Market {
    id: number;
    address: string;
    title: string;
    prices: number[]; // [YES price, NO price] e.g. [42.8, 57.2]
    tradeType: 'amm' | 'clob' | 'group';
    marketType: 'single' | 'group';
    slug: string;
    venue: MarketVenue;
    positionIds: string[]; // [YES token ID, NO token ID]
    collateralToken: Token;
    volume: string; // Raw units
    volumeFormatted: string; // Human readable
    liquidity: string;
    liquidityFormatted: string;
    expirationTimestamp: number; // ms
    status: 'FUNDED' | 'CLOSED' | 'RESOLVED';
    // Additional fields might be present
}

export interface MarketDetail extends Market {
    description?: string;
    resolutionSource?: string;
}

export interface MarketSlugMeta {
    slug: string;
    collateralToken: Token;
    expirationTimestamp: number;
}

export interface OrderbookLevel {
    price: string; // Price in cents/shares? API usually returns raw. Need to confirm unit.
    // User prompt says "prices[0] = YES price (0-100)".
    // CLOB API usually returns price as raw uint256 or string.
    // We will assume string for safety.
    size: string;
}

export interface Orderbook {
    bids: OrderbookLevel[];
    asks: OrderbookLevel[];
    midpoint?: number;
}

/** Supported order execution strategies */
export type OrderType = 'GTC' | 'FOK' | 'FAK';

export interface Order {
    id: string;
    marketSlug: string;
    side: 'YES' | 'NO';
    price: number;
    size: number;
    filledSize: number;
    status: 'OPEN' | 'FILLED' | 'CANCELLED' | 'EXPIRED';
    timestamp: number;
    /** Matches returned when an FAK or FOK order fills immediately */
    makerMatches?: any[];
}

/** Parameters for creating a self-signed order */
export interface CreateOrderParams {
    marketSlug: string;
    side: 'YES' | 'NO';
    /** Limit price in cents, 1–99. E.g. 50 means 50¢ per contract. */
    limitPriceCents: number;
    /** Amount in USD to spend. E.g. 10 means $10. */
    usdAmount: number;
    /** Order type. Defaults to 'FOK'. */
    orderType?: OrderType;
    /**
     * GTC only. When true, the order is rejected if it would immediately match
     * against existing orders. Guarantees maker-only execution.
     */
    postOnly?: boolean;
}

/** Parameters for redeeming resolved positions via the API */
export interface RedeemParams {
    /** CTF condition ID (bytes32 hex string) */
    conditionId: string;
    /** Managed sub-account profile ID (partner flow only) */
    onBehalfOf?: number;
}

/** Parameters for withdrawing funds from a managed server wallet */
export interface WithdrawParams {
    /** Amount to withdraw (human-readable, e.g. "50" for 50 USDC) */
    amount: string;
    /** Token contract address */
    token: string;
    /** Managed sub-account profile ID (partner flow only) */
    onBehalfOf?: number;
}

// EIP-712 Types
export const EIP712_DOMAIN = {
    name: 'Limitless CTF Exchange',
    version: '1',
    chainId: 8453,
    // verifyingContract is dynamic per market
} as const;

export const EIP712_TYPES = {
    Order: [
        { name: 'salt', type: 'uint256' },
        { name: 'maker', type: 'address' },
        { name: 'signer', type: 'address' },
        { name: 'taker', type: 'address' },
        { name: 'tokenId', type: 'uint256' },
        { name: 'makerAmount', type: 'uint256' },
        { name: 'takerAmount', type: 'uint256' },
        { name: 'expiration', type: 'uint256' },
        { name: 'nonce', type: 'uint256' },
        { name: 'feeRateBps', type: 'uint256' },
        { name: 'side', type: 'uint8' },
        { name: 'signatureType', type: 'uint8' },
    ]
} as const;

export interface SignedOrder {
    salt: number | string;
    maker: string;
    signer: string;
    taker: string;
    tokenId: string;
    makerAmount: string | number;
    takerAmount: string | number;
    expiration: string | number;
    nonce: number;
    feeRateBps: number;
    side: 0 | 1; // 0 = BUY, 1 = SELL
    signatureType: 0 | 1; // 0 = EOA
    signature: string;
}

export interface FeedEvent {
    user: string;
    description: string;
    timestamp: number;
    // Add other fields as discovered
}
