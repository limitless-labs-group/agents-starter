/**
 * init — scaffold a fresh checkout without ever touching a secret.
 *
 *   npm run init
 *
 * Creates `.env` from `.env.example` if it does not exist (mode 0600), makes
 * `data/`, and prints exactly which credentials to add and where to get them.
 * It never opens `.env` after creating it; the operator fills it in by hand.
 * Re-run it any time; it is idempotent. `npm run doctor` verifies the values.
 *
 * For the cross-venue strategy's guided setup (Polymarket deposit wallet,
 * bridge funding) use `npm run cross-market-mm:init` afterwards.
 */

import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const envPath = path.join(root, '.env');
const examplePath = path.join(root, '.env.example');
const dataDir = path.join(root, 'data');

function main(): void {
  console.log('Limitless agents-starter · init\n');

  if (fs.existsSync(envPath)) {
    console.log('  ✓ .env exists (not modified)');
  } else if (fs.existsSync(examplePath)) {
    fs.copyFileSync(examplePath, envPath);
    fs.chmodSync(envPath, 0o600);
    console.log('  ✓ created .env from .env.example (mode 600)');
  } else {
    console.log('  ✗ .env.example missing — is this the repo root?');
    process.exitCode = 1;
    return;
  }

  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
    console.log('  ✓ created data/');
  } else {
    console.log('  ✓ data/ exists');
  }

  console.log(`
Credentials to add to .env yourself (this script never opens .env after creating it):

  PRIVATE_KEY        dedicated trading EOA on Base. Never your main wallet.
  LMTS_TOKEN_ID      Limitless scoped HMAC token id
  LMTS_TOKEN_SECRET  Limitless scoped HMAC token secret (base64)

  Token: limitless.exchange → connect the SAME wallet as PRIVATE_KEY → API token modal
         → "API Tokens" tab → Derive → copy tokenId + secret.
         Decline the one-time "1-click trading" smart-wallet prompt; self-signed orders need EOA mode.
         Headless/CI alternative: npm run derive-token

Funding: USDC on Base (collateral) + a little ETH on Base (gas for approvals/redeem only).

Next:
  npm run doctor                 # verifies key, token, wallet mode, balances
  npm run certainty-closer       # simplest strategy, dry-run by default
  npm run template               # bare skeleton to build your own strategy on

Cross-venue market making needs one more guided step: npm run cross-market-mm:init
`);
}

main();
