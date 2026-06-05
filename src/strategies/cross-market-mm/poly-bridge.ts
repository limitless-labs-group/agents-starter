/**
 * Polymarket deposit bridge — turn USDC on any supported chain into pUSD in a
 * deposit wallet.
 *
 * You do NOT send USDC to the deposit wallet directly (that's not pUSD buying
 * power). You ask the bridge for a one-time deposit address tied to your
 * deposit wallet, send USDC there, and the bridge swaps it to pUSD and credits
 * the deposit wallet. See https://docs.polymarket.com/trading/bridge/deposit
 */

const BRIDGE_URL = 'https://bridge.polymarket.com';

export interface BridgeAddresses {
  evm: string; // send EVM-chain assets (Base/Polygon/Ethereum/… USDC) here
  svm?: string;
  tron?: string;
  btc?: string;
}

/**
 * Ask the bridge for the deposit address(es) that credit `depositWallet` with
 * pUSD. Optional builder code (X-Builder-Code) for attribution if set in env.
 */
export async function getDepositAddresses(depositWallet: string): Promise<BridgeAddresses> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const builderCode = process.env.POLYMARKET_BUILDER_CODE;
  if (builderCode) headers['X-Builder-Code'] = builderCode;

  const res = await fetch(`${BRIDGE_URL}/deposit`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ address: depositWallet }),
  });
  if (!res.ok) throw new Error(`bridge /deposit failed: ${res.status} ${res.statusText}`);
  const body = (await res.json()) as { address?: BridgeAddresses };
  if (!body.address?.evm) throw new Error(`bridge returned no evm address: ${JSON.stringify(body)}`);
  return body.address;
}

/** Minimum USDC deposit on Base (chainId 8453), in USD. null if it can't be read. */
export async function getBaseUsdcMin(): Promise<number | null> {
  try {
    const res = await fetch(`${BRIDGE_URL}/supported-assets`);
    if (!res.ok) return null;
    const body = (await res.json()) as
      | { supportedAssets?: SupportedAsset[] }
      | SupportedAsset[];
    const list = Array.isArray(body) ? body : (body.supportedAssets ?? []);
    const usdc = list.find((a) => String(a.chainId) === '8453' && a.token?.symbol === 'USDC');
    return usdc?.minCheckoutUsd ?? null;
  } catch {
    return null;
  }
}

interface SupportedAsset {
  chainId: string | number;
  token?: { symbol?: string };
  minCheckoutUsd?: number;
}
