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

/** One inbound inline-button tap reduced to what a handler needs. */
export interface TelegramCallback {
  /** Numeric update id — pass `offset = updateId + 1` to ack it. */
  updateId: number;
  /** Opaque id used to answer the query (stops the client-side spinner). */
  callbackQueryId: string;
  /** The chat the tap came from (string for uniform comparison). */
  chatId: string;
  /** The message the inline keyboard is attached to (so we can edit it). */
  messageId: number;
  /** The button's `callback_data`, e.g. "mm:kill". */
  data: string;
}

/** A single inline keyboard, the only markup the dashboard needs. */
export interface InlineKeyboard {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
}

/** Both kinds of inbound update from one long-poll, already ack-advanced. */
export interface PollResult {
  commands: TelegramCommand[];
  callbacks: TelegramCallback[];
  /** Offset to pass to the next poll (maxUpdateId + 1, or the input offset). */
  nextOffset: number;
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

  /**
   * Post an HTML message with an optional inline keyboard and return its
   * `message_id` (needed so the live dashboard card can be edited in place).
   * Returns null on any failure — callers treat that as "no card yet".
   */
  async sendCard(text: string, keyboard?: InlineKeyboard): Promise<number | null> {
    try {
      const res = await fetch(`${API_BASE}/bot${this.botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: this.chatId,
          text,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          ...(keyboard ? { reply_markup: keyboard } : {}),
        }),
      });
      if (!res.ok) {
        logger.warn({ status: res.status }, 'telegram sendCard failed');
        return null;
      }
      const body = (await res.json()) as { ok: boolean; result?: { message_id?: number } };
      return body.ok ? (body.result?.message_id ?? null) : null;
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : err }, 'telegram sendCard error');
      return null;
    }
  }

  /**
   * Edit a previously-sent card in place (text + keyboard). Best-effort: a
   * failure (e.g. "message is not modified" when nothing changed) is logged at
   * debug and swallowed so the refresh loop never throws.
   */
  async editCard(messageId: number, text: string, keyboard?: InlineKeyboard): Promise<boolean> {
    try {
      const res = await fetch(`${API_BASE}/bot${this.botToken}/editMessageText`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: this.chatId,
          message_id: messageId,
          text,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          ...(keyboard ? { reply_markup: keyboard } : {}),
        }),
      });
      if (!res.ok) {
        logger.debug({ status: res.status }, 'telegram editCard non-ok');
        return false;
      }
      return true;
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : err }, 'telegram editCard error');
      return false;
    }
  }

  /** Acknowledge a button tap (stops the spinner; optional toast text). */
  async answerCallback(callbackQueryId: string, text?: string): Promise<void> {
    try {
      await fetch(`${API_BASE}/bot${this.botToken}/answerCallbackQuery`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ callback_query_id: callbackQueryId, ...(text ? { text } : {}) }),
      });
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : err }, 'telegram answerCallback error');
    }
  }

  /**
   * Long-poll for both message and callback_query updates in one call.
   * `offset` acks everything before it. Returns empty lists + the same offset
   * on any error so a poll loop can simply retry.
   */
  async poll(offset: number, timeoutSec = 30, signal?: AbortSignal): Promise<PollResult> {
    const empty: PollResult = { commands: [], callbacks: [], nextOffset: offset };
    try {
      const res = await fetch(
        `${API_BASE}/bot${this.botToken}/getUpdates?offset=${offset}&timeout=${timeoutSec}` +
          `&allowed_updates=%5B%22message%22%2C%22callback_query%22%5D`,
        { method: 'GET', signal },
      );
      if (!res.ok) {
        logger.warn({ status: res.status }, 'telegram poll failed');
        return empty;
      }
      const body = (await res.json()) as {
        ok: boolean;
        result?: Array<{
          update_id: number;
          message?: { chat?: { id?: number }; text?: string };
          callback_query?: {
            id: string;
            data?: string;
            message?: { chat?: { id?: number }; message_id?: number };
          };
        }>;
      };
      if (!body.ok || !body.result) return empty;
      const commands: TelegramCommand[] = [];
      const callbacks: TelegramCallback[] = [];
      let maxId = offset - 1;
      for (const u of body.result) {
        if (u.update_id > maxId) maxId = u.update_id;
        const text = u.message?.text;
        const msgChat = u.message?.chat?.id;
        if (text && msgChat != null) {
          commands.push({ updateId: u.update_id, chatId: String(msgChat), text });
        }
        const cq = u.callback_query;
        if (cq && cq.data && cq.message?.message_id != null && cq.message.chat?.id != null) {
          callbacks.push({
            updateId: u.update_id,
            callbackQueryId: cq.id,
            chatId: String(cq.message.chat.id),
            messageId: cq.message.message_id,
            data: cq.data,
          });
        }
      }
      return { commands, callbacks, nextOffset: maxId + 1 };
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : err }, 'telegram poll error');
      return empty;
    }
  }
}
