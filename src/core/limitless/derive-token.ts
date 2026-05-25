/**
 * Derive a Limitless scoped HMAC token from a Privy identity token.
 *
 *   npm run derive-token              # reads PRIVY_IDENTITY_TOKEN from env
 *   npm run derive-token <token>      # or pass it as an arg
 *
 * Prints paste-ready `LMTS_TOKEN_ID` / `LMTS_TOKEN_SECRET` lines for your .env.
 *
 * ── Where the Privy identity token comes from ──────────────────────────────
 * Scoped tokens are derived against your Privy login, so you need a fresh
 * Privy identity token (one-time):
 *   1. Log in at https://limitless.exchange with your wallet.
 *   2. Open DevTools → Application/Storage → look for the Privy auth response,
 *      or Network tab → find the `privy.io` authenticate call and copy the
 *      `token` field from its JSON response (NOT `privy_access_token`).
 *   3. Run: PRIVY_IDENTITY_TOKEN=<paste> npm run derive-token
 *
 * The `trading` scope is available to all users with no application. This is
 * a one-time setup — the resulting tokenId + secret are long-lived HMAC creds.
 */

import { config as loadEnv } from 'dotenv';
import { Client } from '@limitless-exchange/sdk';
import pino from 'pino';

loadEnv();

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: { target: 'pino-pretty', options: { colorize: true } },
});

async function main(): Promise<void> {
  const identityToken = process.argv[2] || process.env.PRIVY_IDENTITY_TOKEN;
  if (!identityToken) {
    logger.error(
      'No Privy identity token. Pass it as an arg or set PRIVY_IDENTITY_TOKEN. ' +
        'See the header of src/core/limitless/derive-token.ts for how to grab it.',
    );
    process.exitCode = 1;
    return;
  }

  // Scope defaults to ['trading'] — the base scope every user has without an
  // application. Override with TOKEN_SCOPES=trading,account_creation,... if you
  // have partner-level scopes enabled.
  const scopes = (process.env.TOKEN_SCOPES || 'trading')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const label = process.env.TOKEN_LABEL || 'agents-starter';

  const client = new Client({
    baseURL: process.env.LIMITLESS_API_URL || 'https://api.limitless.exchange',
  });

  logger.info({ scopes, label }, 'Deriving scoped API token…');

  let res;
  try {
    res = await client.apiTokens.deriveToken(identityToken, { label, scopes });
  } catch (err) {
    logger.error(
      { err: (err as Error).message },
      'Token derivation failed. The Privy identity token may be expired ' +
        '(they are short-lived — re-grab from the browser) or the scope may ' +
        'require partner access. See docs.limitless.exchange/developers/authentication.',
    );
    process.exitCode = 1;
    return;
  }

  // The response carries tokenId + secret. Print paste-ready env lines.
  const tokenId = (res as { tokenId?: string }).tokenId;
  const secret = (res as { secret?: string }).secret;
  if (!tokenId || !secret) {
    logger.error({ res }, 'Unexpected derive response — no tokenId/secret');
    process.exitCode = 1;
    return;
  }

  logger.info('Token derived. Add these to your .env (keep the secret private):');
  // Plain stdout so it's easy to copy without log decoration.
  process.stdout.write(`\nLMTS_TOKEN_ID=${tokenId}\nLMTS_TOKEN_SECRET=${secret}\n\n`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('derive-token failed:', err);
  process.exitCode = 1;
});
