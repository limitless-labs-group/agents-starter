/**
 * telegram-test — verify TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID work.
 *
 *   npm run cross-market-mm:telegram-test
 *
 * Sends one message to the configured chat and reports success/failure, so you
 * can confirm credentials before a live run instead of discovering a typo'd
 * token mid-demo. Only relevant if you use the OPTIONAL direct-push notifier;
 * if an orchestrating agent relays the status file, you don't need this.
 */

import 'dotenv/config';
import { TelegramClient } from '../../core/telegram/client.js';

async function main(): Promise<void> {
  const tg = TelegramClient.fromEnv();
  if (!tg) {
    console.error('TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID not set in .env — nothing to test.');
    process.exit(1);
  }
  const ok = await tg.sendMessage('✅ <b>cross-market-mm</b> — Telegram credentials work.');
  if (ok) {
    console.log('Sent. Check your Telegram chat.');
  } else {
    console.error('Send failed — check the bot token and chat id (see logged status above).');
    process.exit(1);
  }
}

main().catch((e: unknown) => {
  console.error('telegram-test failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});
