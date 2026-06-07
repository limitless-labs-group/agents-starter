/**
 * Cross-market-mm Telegram dashboard — card rendering, keyboard states, and the
 * halt-only control routing (with chat authorization).
 */

import { describe, expect, it } from 'vitest';
import type { TelegramCallback, TelegramClient, TelegramCommand } from '../../src/core/telegram/client.js';
import {
  CrossMarketTelegram,
  dashboardKeyboard,
  fmtCard,
  shortLabel,
  type CardQuoteRow,
  type DashboardControls,
} from '../../src/strategies/cross-market-mm/telegram.js';

const rows: CardQuoteRow[] = [
  {
    title: 'will-the-carolina-hurricanes-win-the-2026-nhl-stanley-cup',
    bid: 0.359,
    ask: 0.371,
    net: 0,
    state: 'two_sided',
  },
];

describe('shortLabel', () => {
  it('strips the will-the / -win-the boilerplate', () => {
    expect(shortLabel('will-the-carolina-hurricanes-win-the-2026-nhl-stanley-cup')).toBe(
      'carolina hurricanes',
    );
  });

  it('strips a trailing limitless id suffix', () => {
    expect(shortLabel('vegas-golden-knights-1766489096435')).toBe('vegas golden knights');
  });

  it('truncates a long unrecognized title', () => {
    const s = shortLabel('some-extremely-long-market-title-that-keeps-going-and-going');
    expect(s.length).toBeLessThanOrEqual(26);
    expect(s.endsWith('…')).toBe(true);
  });
});

describe('fmtCard', () => {
  const base = { elapsedMs: 60_000, pnl: 1.2, equity: 648.01, hedges: 2, rows };

  it('renders a live board with quote, net, equity, hedges', () => {
    const s = fmtCard({ ...base, live: true, pulled: false, killed: false });
    expect(s).toContain('live');
    expect(s).toContain('carolina hurricanes');
    expect(s).toContain('0.359 / 0.371');
    expect(s).toContain('net +0.00');
    expect(s).toContain('648.01');
    expect(s).toContain('2 hedges');
  });

  it('shows dry / paused / halted headers', () => {
    expect(fmtCard({ ...base, live: false, pulled: false, killed: false })).toContain('dry run');
    expect(fmtCard({ ...base, live: true, pulled: true, killed: false })).toContain('paused');
    expect(fmtCard({ ...base, live: true, pulled: false, killed: true })).toContain('HALTED');
  });

  it('handles an empty board', () => {
    const s = fmtCard({ ...base, rows: [], live: true, pulled: false, killed: false });
    expect(s).toContain('no quotes yet');
  });
});

describe('dashboardKeyboard', () => {
  const data = (k: ReturnType<typeof dashboardKeyboard>) =>
    k.inline_keyboard.flat().map((b) => b.callback_data);

  it('offers pull / refresh / kill by default', () => {
    expect(data(dashboardKeyboard({ pulled: false, killed: false, confirmingKill: false }))).toEqual(
      expect.arrayContaining(['mm:pull', 'mm:refresh', 'mm:kill']),
    );
  });

  it('swaps pull for resume when paused', () => {
    const d = data(dashboardKeyboard({ pulled: true, killed: false, confirmingKill: false }));
    expect(d).toContain('mm:resume');
    expect(d).not.toContain('mm:pull');
  });

  it('shows confirm / cancel mid-kill, and only refresh once halted', () => {
    const confirm = data(dashboardKeyboard({ pulled: false, killed: false, confirmingKill: true }));
    expect(confirm).toEqual(expect.arrayContaining(['mm:confirm_kill', 'mm:cancel']));
    expect(confirm).not.toContain('mm:kill');
    expect(data(dashboardKeyboard({ pulled: false, killed: true, confirmingKill: false }))).toEqual([
      'mm:refresh',
    ]);
  });
});

describe('hedge_skip pings', () => {
  it('pings only on transition into a skip state, then clears once resolved', () => {
    const { client, tg } = harness();
    const skip = {
      t: 1,
      kind: 'hedge_skip',
      pair: 'btc-up',
      reason: 'notional too small',
      buy: 'YES',
      shares: 5,
      price: 0.19,
      usdc: 0.95,
      net: -5,
      threshold: 2,
    } as const;

    tg.onEvent(skip);
    tg.onEvent({ ...skip, t: 2 });
    expect(client.sent.filter((s) => s.includes('Hedge skipped'))).toHaveLength(1);

    tg.onEvent({ t: 3, kind: 'snapshot', pair: 'btc-up', net: 0, lmtsYes: 0, lmtsNo: 0, polyYes: 0, polyNo: 0 });
    tg.onEvent({ ...skip, t: 4 });
    expect(client.sent.filter((s) => s.includes('Hedge skipped'))).toHaveLength(2);
  });

  it('clears the skip state after a successful hedge on the pair', () => {
    const { client, tg } = harness();
    const skip = {
      t: 1,
      kind: 'hedge_skip',
      pair: 'btc-up',
      reason: 'notional too small',
      buy: 'YES',
      shares: 5,
      price: 0.19,
      usdc: 0.95,
      net: -5,
      threshold: 2,
    } as const;

    tg.onEvent(skip);
    tg.onEvent({ t: 2, kind: 'hedge', pair: 'btc-up', buy: 'YES', shares: 5, price: 0.22, usdc: 1.1, success: true });
    tg.onEvent({ ...skip, t: 3 });

    expect(client.sent.filter((s) => s.includes('Hedge skipped'))).toHaveLength(2);
    expect(client.sent.filter((s) => s.includes('Fill → hedged'))).toHaveLength(1);
  });
});

// -- Control routing -------------------------------------------------------

class FakeClient {
  authorizedChatId = '123';
  sent: string[] = [];
  edits: Array<{ id: number; text: string }> = [];
  answers: Array<{ id: string; text?: string }> = [];
  async sendMessage(text: string): Promise<boolean> {
    this.sent.push(text);
    return true;
  }
  async sendCard(text: string): Promise<number | null> {
    this.sent.push(text);
    return 555;
  }
  async editCard(id: number, text: string): Promise<boolean> {
    this.edits.push({ id, text });
    return true;
  }
  async answerCallback(id: string, text?: string): Promise<void> {
    this.answers.push({ id, text });
  }
}

function harness() {
  const calls: string[] = [];
  const controls: DashboardControls = {
    kill: () => calls.push('kill'),
    pull: () => calls.push('pull'),
    resume: () => calls.push('resume'),
    isPulled: () => false,
    isKilled: () => false,
  };
  const client = new FakeClient();
  const tg = new CrossMarketTelegram(client as unknown as TelegramClient, {
    dashboard: { quotesPath: '/nonexistent/quotes.json', controls },
  });
  return { calls, client, tg };
}

const cb = (data: string, chatId = '123'): TelegramCallback => ({
  updateId: 1,
  callbackQueryId: 'q1',
  chatId,
  messageId: 5,
  data,
});

describe('handleCallback (halt-only controls)', () => {
  it('pauses on mm:pull and acks', async () => {
    const { calls, client, tg } = harness();
    await tg.handleCallback(cb('mm:pull'));
    expect(calls).toEqual(['pull']);
    expect(client.answers[0]?.text).toContain('paused');
    expect(client.edits.length).toBe(1); // card refreshed
  });

  it('requires a second tap to kill (two-tap confirm)', async () => {
    const { calls, tg } = harness();
    await tg.handleCallback(cb('mm:kill'));
    expect(calls).toEqual([]); // first tap only arms confirm
    await tg.handleCallback(cb('mm:confirm_kill'));
    expect(calls).toEqual(['kill']);
  });

  it('ignores taps from an unauthorized chat — no side effect, no ack', async () => {
    const { calls, client, tg } = harness();
    await tg.handleCallback(cb('mm:confirm_kill', '999'));
    expect(calls).toEqual([]);
    expect(client.answers.length).toBe(0);
    expect(client.edits.length).toBe(0);
  });

  it('refresh acks without touching controls', async () => {
    const { calls, client, tg } = harness();
    await tg.handleCallback(cb('mm:refresh'));
    expect(calls).toEqual([]);
    expect(client.answers[0]?.text).toContain('Refreshed');
  });
});

describe('handleCommand (/status)', () => {
  it('reposts a card for the authorized chat', async () => {
    const { client, tg } = harness();
    const cmd: TelegramCommand = { updateId: 2, chatId: '123', text: '/status' };
    await tg.handleCommand(cmd);
    expect(client.sent.length).toBe(1);
  });

  it('ignores /status from an unauthorized chat', async () => {
    const { client, tg } = harness();
    const cmd: TelegramCommand = { updateId: 2, chatId: '999', text: '/status' };
    await tg.handleCommand(cmd);
    expect(client.sent.length).toBe(0);
  });
});
