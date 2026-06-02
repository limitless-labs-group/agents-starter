/**
 * Minimal Telegram Bot API transport.
 *
 * Knows nothing about any strategy — it just sends messages to, and (later)
 * reads commands from, one authorized chat. Strategy-specific formatting and
 * event wiring live in the strategy (e.g. cross-market-mm/telegram.ts).
 *
 * Outbound is best-effort: a failed send logs and returns false, never throws,
 * so a Telegram outage can't take down a running bot. Credentials come from
 * the environment and are optional — `fromEnv()` returns null when unset, which
 * callers treat as "monitoring disabled".
 */

import { pino } from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL || 'info', name: 'telegram' });

const API_BASE = 'https://api.telegram.org';

/** One inbound update reduced to what a command handler needs. */
export interface TelegramCommand {
  /** Numeric update id — pass `offset = updateId + 1` to ack it. */
  updateId: number;
  /** The chat the message came from (string for uniform comparison). */
  chatId: string;
  /** Raw message text, e.g. "/status". */
  text: string;
}

export class TelegramClient {
  constructor(
    private readonly botToken: string,
    private readonly chatId: string,
  ) {}

  /**
   * Build from `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`. Returns null if either
   * is unset — callers use that to mean "Telegram monitoring is off".
   */
  static fromEnv(): TelegramClient | null {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!botToken || !chatId) return null;
    return new TelegramClient(botToken, chatId);
  }

  /** The single chat authorized to issue commands and receive messages. */
  get authorizedChatId(): string {
    return this.chatId;
  }

  /** Send an HTML-formatted message to the authorized chat. Never throws. */
  async sendMessage(text: string): Promise<boolean> {
    try {
      const res = await fetch(`${API_BASE}/bot${this.botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: this.chatId,
          text,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        }),
      });
      if (!res.ok) {
        logger.warn({ status: res.status }, 'telegram sendMessage failed');
        return false;
      }
      return true;
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : err }, 'telegram sendMessage error');
      return false;
    }
  }

  /**
   * Long-poll for new updates. `offset` acks everything before it (Telegram
   * drops updates < offset). `timeoutSec` is server-side long-poll hold time.
   * Returns [] on any error so a poll loop can simply retry. Only `message`
   * updates with text are surfaced.
   */
  async getCommands(offset: number, timeoutSec = 30): Promise<TelegramCommand[]> {
    try {
      const res = await fetch(
        `${API_BASE}/bot${this.botToken}/getUpdates?offset=${offset}&timeout=${timeoutSec}&allowed_updates=%5B%22message%22%5D`,
        { method: 'GET' },
      );
      if (!res.ok) {
        logger.warn({ status: res.status }, 'telegram getUpdates failed');
        return [];
      }
      const body = (await res.json()) as {
        ok: boolean;
        result?: Array<{ update_id: number; message?: { chat?: { id?: number }; text?: string } }>;
      };
      if (!body.ok || !body.result) return [];
      const cmds: TelegramCommand[] = [];
      for (const u of body.result) {
        const text = u.message?.text;
        const chatId = u.message?.chat?.id;
        if (text && chatId != null) {
          cmds.push({ updateId: u.update_id, chatId: String(chatId), text });
        }
      }
      return cmds;
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : err }, 'telegram getUpdates error');
      return [];
    }
  }
}
