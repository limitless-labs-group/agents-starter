/**
 * PortfolioClient over a fake SDK: position token reads, fill verification,
 * and the trade-wallet-mode switch going through the axios PUT.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Client } from '@limitless-exchange/sdk';
import { PortfolioClient } from '../../src/core/limitless/portfolio.js';

function fakeSdk() {
  const put = vi.fn().mockResolvedValue({ data: { id: 1, tradeWalletOption: 'eoa' } });
  const sdk = {
    http: { client: { put } },
    portfolio: {
      getProfile: vi.fn().mockResolvedValue({ id: 1, account: '0xabc', tradeWalletOption: 'smartWallet' }),
      getCLOBPositions: vi.fn().mockResolvedValue([
        { market: { slug: 'm' }, tokensBalance: { yes: '2500000', no: '0' } },
        { market: { slug: 'other' }, tokensBalance: { yes: '0', no: '1000000' } },
      ]),
    },
  } as unknown as Client;
  return { sdk, put };
}

describe('PortfolioClient', () => {
  it('reads YES/NO shares for a market from the positions snapshot', async () => {
    const { sdk } = fakeSdk();
    const p = new PortfolioClient(sdk);
    expect(await p.getPositionTokens('m')).toEqual({ yes: 2.5, no: 0 });
    expect(await p.getPositionTokens('unknown')).toEqual({ yes: 0, no: 0 });
  });

  it('verifyFill reports the side that was bought', async () => {
    const { sdk } = fakeSdk();
    const p = new PortfolioClient(sdk);
    expect(await p.verifyFill('m', 'YES')).toEqual({ filled: true, shares: 2.5 });
    expect(await p.verifyFill('m', 'NO')).toEqual({ filled: false, shares: 0 });
  });

  it('getTradeWalletMode returns the profile value', async () => {
    const { sdk } = fakeSdk();
    expect(await new PortfolioClient(sdk).getTradeWalletMode()).toBe('smartWallet');
  });

  it('setTradeWalletMode PUTs /profiles with the new mode', async () => {
    const { sdk, put } = fakeSdk();
    const profile = await new PortfolioClient(sdk).setTradeWalletMode('eoa');
    expect(put).toHaveBeenCalledWith('/profiles', { tradeWalletOption: 'eoa' });
    expect(profile.tradeWalletOption).toBe('eoa');
  });
});
