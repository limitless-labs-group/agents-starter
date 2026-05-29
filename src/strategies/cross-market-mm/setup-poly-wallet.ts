/**
 * setup-poly-wallet — one-time Polymarket deposit-wallet setup for API trading.
 *
 *   npm run cross-market-mm:setup-poly
 *
 * Polymarket's CLOB rejects orders from a Gnosis Safe maker ("use the deposit
 * wallet flow"). New API users trade via a POLY_1271 *deposit wallet* (sig type
 * 3): a deterministic per-EOA proxy. This command, using your RELAYER_API_KEY
 * (gasless), will:
 *   1. derive your deposit-wallet address,
 *   2. deploy it via the relayer if it isn't deployed,
 *   3. approve pUSD (the CLOB collateral) for the Polymarket v2 exchanges so it
 *      can place orders.
 *
 * Then set in cross-market-mm.config.yaml:
 *   poly_funder: <the printed deposit-wallet address>
 *   poly_signature_type: 3
 * and transfer your pUSD into that deposit wallet (pUSD held elsewhere is not
 * CLOB buying power).
 *
 * Requires in .env: PRIVATE_KEY, RELAYER_API_KEY, RELAYER_API_KEY_ADDRESS
 * (create the relayer key in the Polymarket builder dashboard).
 */

import 'dotenv/config';
import { privateKeyToAccount } from 'viem/accounts';
import {
  createWalletClient,
  createPublicClient,
  http,
  encodeFunctionData,
  parseAbi,
  maxUint256,
} from 'viem';
import { polygon } from 'viem/chains';
import { RelayClient, RelayerTransactionState } from '@polymarket/builder-relayer-client';
import { loadSettings } from './config.js';

const RELAYER_URL = 'https://relayer-v2.polymarket.com';
const PUSD = '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB';
// Polymarket v2 contracts on Polygon (from @polymarket/clob-client-v2).
const POLY_EXCHANGES = {
  exchangeV2: '0xE111180000d2663C0091e4f400237545B87B996B',
  negRiskExchangeV2: '0xe2222d279d744050d28e00520010520000310F59',
  negRiskAdapter: '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296',
};
// Polymarket ConditionalTokens (CTF) on Polygon mainnet — selling outcome
// tokens needs setApprovalForAll on this for the exchange operators.
const CTFS = ['0x4D97DCd97eC945f40cF65F87097ACe5EA0476045'];
const ERC20 = parseAbi([
  'function approve(address,uint256) returns (bool)',
  'function allowance(address,address) view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
]);
const CTF_ABI = parseAbi([
  'function setApprovalForAll(address,bool)',
  'function isApprovedForAll(address,address) view returns (bool)',
]);
const CONFIRMED = [RelayerTransactionState.STATE_CONFIRMED, RelayerTransactionState.STATE_MINED];

async function main(): Promise<void> {
  const apiKey = process.env.RELAYER_API_KEY;
  const apiKeyAddr = process.env.RELAYER_API_KEY_ADDRESS;
  if (!apiKey || !apiKeyAddr) {
    throw new Error(
      'Set RELAYER_API_KEY + RELAYER_API_KEY_ADDRESS in .env (create a relayer ' +
        'API key in the Polymarket builder dashboard).',
    );
  }

  const s = loadSettings();
  const pk = (s.privateKey.startsWith('0x') ? s.privateKey : `0x${s.privateKey}`) as `0x${string}`;
  const wallet = createWalletClient({ account: privateKeyToAccount(pk), chain: polygon, transport: http() });
  const pub = createPublicClient({ chain: polygon, transport: http() });

  const relayer = new RelayClient(RELAYER_URL, 137, wallet);
  // Relayer API-key header auth (the relayer client otherwise uses builder HMAC).
  const inst = (relayer as unknown as { httpClient: { instance: { defaults: { headers: { common: Record<string, string> } } } } }).httpClient.instance;
  inst.defaults.headers.common['RELAYER_API_KEY'] = apiKey;
  inst.defaults.headers.common['RELAYER_API_KEY_ADDRESS'] = apiKeyAddr;

  // 1. Derive
  const dw = (await relayer.deriveDepositWalletAddress()) as `0x${string}`;
  console.log(`\nDeposit wallet (POLY_1271): ${dw}`);

  // 2. Deploy if needed
  const code = await pub.getBytecode({ address: dw });
  if (code && code !== '0x') {
    console.log('  ✅ already deployed');
  } else {
    console.log('  deploying via relayer (gasless)…');
    const resp = (await relayer.deployDepositWallet()) as { transactionID?: string; transactionId?: string };
    const txId = resp.transactionID ?? resp.transactionId;
    const final = await relayer.pollUntilState(txId as string, CONFIRMED, RelayerTransactionState.STATE_FAILED);
    console.log(`  deploy: ${final?.state}`);
  }

  // 3. Approvals (skip any already set). Two kinds, both needed:
  //    • pUSD ERC-20 approve  → BUY (place hedge orders)
  //    • CTF setApprovalForAll → SELL (close inventory back to flat)
  const calls: Array<{ target: string; value: string; data: string }> = [];
  for (const [name, spender] of Object.entries(POLY_EXCHANGES)) {
    const allowance = (await pub.readContract({
      address: PUSD,
      abi: ERC20,
      functionName: 'allowance',
      args: [dw, spender as `0x${string}`],
    })) as bigint;
    if (allowance > 0n) console.log(`  ✅ pUSD approved (buy): ${name}`);
    else
      calls.push({
        target: PUSD,
        value: '0',
        data: encodeFunctionData({ abi: ERC20, functionName: 'approve', args: [spender as `0x${string}`, maxUint256] }),
      });
  }
  for (const ctf of CTFS) {
    for (const [name, op] of Object.entries(POLY_EXCHANGES)) {
      const approved = (await pub.readContract({
        address: ctf as `0x${string}`,
        abi: CTF_ABI,
        functionName: 'isApprovedForAll',
        args: [dw, op as `0x${string}`],
      })) as boolean;
      if (approved) console.log(`  ✅ CTF ${ctf.slice(0, 8)}… approved (sell): ${name}`);
      else
        calls.push({
          target: ctf,
          value: '0',
          data: encodeFunctionData({ abi: CTF_ABI, functionName: 'setApprovalForAll', args: [op as `0x${string}`, true] }),
        });
    }
  }
  if (calls.length > 0) {
    console.log(`  submitting ${calls.length} approval(s) via relayer (gasless)…`);
    const deadline = String(Math.floor(Date.now() / 1000) + 3600);
    const resp = (await relayer.executeDepositWalletBatch(calls, dw, deadline)) as { transactionID?: string; transactionId?: string };
    const txId = resp.transactionID ?? resp.transactionId;
    const final = await relayer.pollUntilState(txId as string, CONFIRMED, RelayerTransactionState.STATE_FAILED);
    console.log(`  approvals: ${final?.state}`);
  } else {
    console.log('  ✅ all approvals already set');
  }

  const pusdBal = (await pub.readContract({ address: PUSD, abi: ERC20, functionName: 'balanceOf', args: [dw] })) as bigint;
  console.log(`\n✅ Deposit wallet ready. pUSD balance: $${(Number(pusdBal) / 1e6).toFixed(2)}`);
  console.log('\nNext:');
  console.log(`  • set  poly_funder: "${dw}"  and  poly_signature_type: 3  in cross-market-mm.config.yaml`);
  if (pusdBal === 0n) console.log('  • transfer pUSD into the deposit wallet (pUSD held elsewhere is not CLOB buying power)');
  console.log('  • run  npm run cross-market-mm:preflight');
}

main().catch((e: unknown) => {
  console.error('setup-poly-wallet failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});
