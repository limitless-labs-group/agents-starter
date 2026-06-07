/**
 * Cross-market-mm ↔ Telegram glue.
 *
 * Subscribes to the Recorder event stream and turns it into a live channel:
 *   - an instant ping each time a fill is hedged (the interesting moment)
 *   - a "halted" lifecycle message
 *   - a live dashboard *card* that edits in place (quote board, net delta,
 *     equity), an on-demand /status, and halt-only control buttons
 *
 * Noisy events (`order` on every cancel-replace, `snapshot` every tick) are NOT
 * pinged — they only update the in-memory state the card summarizes. The quote
 * board on the card is read from the same `quotes.json` the PanelWriter emits,
 * so there is ONE joined source of the board, not a second derivation here.
 *
 * The formatters are pure and unit-tested. The controls are deliberately
 * halt-only: the buttons can pause quoting or trip the kill switch (writing the
 * same `pull.flag` / `kill.flag` the rest of the bot already watches) — they can
 * never arm live, change size, or place an order. Inbound updates are ignored
 * unless they come from the single authorized chat. A send failure is swallowed.
 */

import fs from 'node:fs';
import type {
  InlineKeyboard,
  TelegramCallback,
  TelegramClient,
  TelegramCommand,
} from '../../core/telegram/client.js';
import type { ReplicatorEvent, TimestampedEvent } from './recorder.js';

type HedgeEvent = Extract<ReplicatorEvent, { kind: 'hedge' }>;
type HedgeSkipEvent = Extract<ReplicatorEvent, { kind: 'hedge_skip' }>;

export interface StartInfo {
  live: boolean;
  pairs: number;
  orderSize: number;
  maxLossUsd: number;
}

export interface HeartbeatState {
  elapsedMs: number;
  pnl: number;
  equity: number;
  net: Array<[string, number]>;
  hedges: number;
}

const signed = (n: number): string => `${n >= 0 ? '+' : ''}${n.toFixed(2)}`;

const elapsed = (ms: number): string => {
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${m % 60}m`;
};

// -- Pure formatters --------------------------------------------------------

export function fmtStarted(i: StartInfo): string {
  const mode = i.live ? '🟢 <b>live</b>' : '🧪 <b>dry run</b>';
  return (
    `▶️ <b>cross-market-mm started</b> — ${mode}\n` +
    `${i.pairs} pair${i.pairs === 1 ? '' : 's'} · order_size ${i.orderSize} · breaker -$${i.maxLossUsd}`
  );
}

export function fmtHedge(ev: HedgeEvent): string {
  const head = ev.success ? '🟢 <b>Fill → hedged</b>' : '⚠️ <b>Hedge failed</b>';
  return (
    `${head}\n` +
    `<code>${ev.pair}</code>\n` +
    `bought ${ev.shares.toFixed(2)} ${ev.buy} @ ${ev.price.toFixed(3)} ($${ev.usdc.toFixed(2)}) on Polymarket`
  );
}

export function fmtHedgeSkip(ev: HedgeSkipEvent): string {
  return (
    `🟠 <b>Hedge skipped</b> — ${ev.reason}\n` +
    `<code>${ev.pair}</code>\n` +
    `net ${ev.net.toFixed(2)} · would buy ${ev.shares.toFixed(2)} ${ev.buy} ` +
    `@ ${ev.price.toFixed(3)} ($${ev.usdc.toFixed(2)})`
  );
}

export function fmtHeartbeat(s: HeartbeatState): string {
  const nets =
    s.net.length > 0
      ? s.net.map(([pair, n]) => `  <code>${pair}</code> ${signed(n)}`).join('\n')
      : '  (no snapshots yet)';
  return (
    `📊 <b>cross-market-mm</b> · ${elapsed(s.elapsedMs)}\n` +
    `PnL $${signed(s.pnl)} · equity $${s.equity.toFixed(2)} · ${s.hedges} hedge${s.hedges === 1 ? '' : 's'}\n` +
    `net delta:\n${nets}`
  );
}

export function fmtHalted(reason: 'circuit-breaker' | 'signal', flat: boolean | null): string {
  const head =
    reason === 'circuit-breaker' ? '🛑 <b>Halted — circuit breaker</b>' : '⏹️ <b>Halted</b>';
  const flatLine =
    flat == null
      ? '' // dry run, or flatten not attempted
      : flat
        ? '\nflat on both venues ✅'
        : '\n⚠️ NOT fully flat — run <code>npm run cross-market-mm:close</code>';
  return head + flatLine;
}

// -- Dashboard: live card + halt-only controls ------------------------------

/**
 * A halt-only control surface. Every method here only ever *reduces* risk:
 * pause quoting, resume quoting, or trip the kill switch. There is no path to
 * arm live, change size, or place an order.
 */
export interface DashboardControls {
  /** Write kill.flag — the bot's existing breaker watcher halts + cancels all. */
  kill: () => void;
  /** Write pull.flag — the replicator cancels resting quotes + stops placing. */
  pull: () => void;
  /** Remove pull.flag — quoting resumes. */
  resume: () => void;
  isPulled: () => boolean;
  isKilled: () => boolean;
}

export interface DashboardOpts {
  /** Path to the quotes.json the bot already emits (the single board source). */
  quotesPath: string;
  controls: DashboardControls;
  /** Card edit cadence in ms (default 15000). */
  refreshMs?: number;
}

/** One quote-board row reduced to what the card shows. */
export interface CardQuoteRow {
  title: string;
  bid: number | null;
  ask: number | null;
  net: number;
  state: string;
}

export interface CardState {
  live: boolean;
  elapsedMs: number;
  pnl: number;
  equity: number;
  hedges: number;
  rows: CardQuoteRow[];
  pulled: boolean;
  killed: boolean;
}

/** Compact a long market slug/title into a phone-readable label. */
export function shortLabel(title: string): string {
  const cleaned = title
    .replace(/^will-the-/, '')
    .replace(/^will-/, '')
    .replace(/-win-the-.*$/, '')
    .replace(/-\d+$/, '')
    .replace(/-/g, ' ')
    .trim();
  const s = cleaned.length > 0 ? cleaned : title;
  return s.length > 26 ? `${s.slice(0, 25)}…` : s;
}

const stateIcon = (state: string): string =>
  state === 'two_sided' ? '✅' : state === 'pulled' ? '⏸' : state === 'stopped' ? '🛑' : '⚠️';

export function fmtCardRow(r: CardQuoteRow): string {
  const quote = r.bid != null && r.ask != null ? `${r.bid.toFixed(3)} / ${r.ask.toFixed(3)}` : '—';
  return `${stateIcon(r.state)} <code>${shortLabel(r.title)}</code>\n   ${quote} · net ${signed(r.net)}`;
}

export function fmtCard(s: CardState): string {
  const mode = s.killed
    ? '🛑 <b>HALTED</b>'
    : s.pulled
      ? '⏸ <b>paused</b>'
      : s.live
        ? '🟢 <b>live</b>'
        : '🧪 <b>dry run</b>';
  const head =
    `📊 <b>cross-market-mm</b> · ${mode} · ${elapsed(s.elapsedMs)}\n` +
    `PnL $${signed(s.pnl)} · equity $${s.equity.toFixed(2)} · ${s.hedges} hedge${s.hedges === 1 ? '' : 's'}`;
  const body = s.rows.length > 0 ? s.rows.map(fmtCardRow).join('\n') : '<i>(no quotes yet)</i>';
  return `${head}\n\n${body}`;
}

/** Inline keyboard reflecting current state. Killed → refresh only; mid-confirm → confirm/cancel. */
export function dashboardKeyboard(s: {
  pulled: boolean;
  killed: boolean;
  confirmingKill: boolean;
}): InlineKeyboard {
  if (s.killed) {
    return { inline_keyboard: [[{ text: '🔄 Refresh', callback_data: 'mm:refresh' }]] };
  }
  if (s.confirmingKill) {
    return {
      inline_keyboard: [
        [
          { text: '⚠️ Confirm kill', callback_data: 'mm:confirm_kill' },
          { text: 'Cancel', callback_data: 'mm:cancel' },
        ],
      ],
    };
  }
  const pause = s.pulled
    ? { text: '▶️ Resume', callback_data: 'mm:resume' }
    : { text: '⏸ Pull quotes', callback_data: 'mm:pull' };
  return {
    inline_keyboard: [
      [pause, { text: '🔄 Refresh', callback_data: 'mm:refresh' }],
      [{ text: '🛑 Kill', callback_data: 'mm:kill' }],
    ],
  };
}

/** Shape of one row in the emitted quotes.json (only the fields the card reads). */
interface RawQuoteRow {
  slug?: string;
  title?: string;
  bid?: { price?: number } | null;
  ask?: { price?: number } | null;
  net_inventory?: number;
  state?: string;
}

/** Parse the emitted quotes.json into card rows. Best-effort: [] on any error. */
export function readQuoteRows(quotesPath: string): CardQuoteRow[] {
  try {
    const raw = JSON.parse(fs.readFileSync(quotesPath, 'utf8')) as RawQuoteRow[];
    if (!Array.isArray(raw)) return [];
    return raw.map((r) => ({
      title: r.title ?? r.slug ?? '?',
      bid: r.bid?.price ?? null,
      ask: r.ask?.price ?? null,
      net: r.net_inventory ?? 0,
      state: r.state ?? '?',
    }));
  } catch {
    return [];
  }
}

// -- Stateful broadcaster ---------------------------------------------------

export class CrossMarketTelegram {
  private latestEquity: { pnl: number; equity: number } | null = null;
  private readonly netByPair = new Map<string, number>();
  private hedges = 0;
  private readonly startedAt = Date.now();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly heartbeatMs: number;
  private readonly dashboard: DashboardOpts | null;
  private readonly activeHedgeSkips = new Set<string>();
  private readonly hedgeSkipThresholdByPair = new Map<string, number>();

  // Dashboard mode only:
  private live = false;
  private cardMessageId: number | null = null;
  private confirmingKill = false;
  private lastCardSig = '';

  constructor(
    private readonly tg: TelegramClient,
    opts: { heartbeatMs?: number; dashboard?: DashboardOpts } = {},
  ) {
    this.heartbeatMs = opts.heartbeatMs ?? 60_000;
    this.dashboard = opts.dashboard ?? null;
  }

  /** Fold one event into live state; ping on a successful hedge. */
  onEvent(ev: TimestampedEvent): void {
    switch (ev.kind) {
      case 'snapshot':
        this.netByPair.set(ev.pair, ev.net);
        this.clearResolvedHedgeSkip(ev.pair, ev.net);
        break;
      case 'equity':
        this.latestEquity = { pnl: ev.pnl, equity: ev.equity };
        break;
      case 'hedge':
        if (ev.success) {
          this.hedges += 1;
          this.clearHedgeSkipsForPair(ev.pair);
        }
        void this.tg.sendMessage(fmtHedge(ev));
        break;
      case 'hedge_skip':
        this.hedgeSkipThresholdByPair.set(ev.pair, ev.threshold);
        if (this.enterHedgeSkip(ev)) void this.tg.sendMessage(fmtHedgeSkip(ev));
        break;
      // 'order' / 'run' are intentionally not pinged.
    }
  }

  private hedgeSkipKey(ev: HedgeSkipEvent): string {
    return `${ev.pair}\u0000${ev.reason}\u0000${ev.buy}`;
  }

  private enterHedgeSkip(ev: HedgeSkipEvent): boolean {
    const key = this.hedgeSkipKey(ev);
    if (this.activeHedgeSkips.has(key)) return false;
    this.activeHedgeSkips.add(key);
    return true;
  }

  private clearHedgeSkipsForPair(pair: string): void {
    for (const key of [...this.activeHedgeSkips]) {
      if (key.startsWith(`${pair}\u0000`)) this.activeHedgeSkips.delete(key);
    }
    this.hedgeSkipThresholdByPair.delete(pair);
  }

  private clearResolvedHedgeSkip(pair: string, net: number): void {
    const threshold = this.hedgeSkipThresholdByPair.get(pair);
    if (threshold == null || Math.abs(net) >= threshold) return;
    this.clearHedgeSkipsForPair(pair);
  }

  /** Announce start: post the live dashboard card, or a one-line ping (legacy mode). */
  async announceStart(info: StartInfo): Promise<void> {
    this.live = info.live;
    if (!this.dashboard) {
      await this.tg.sendMessage(fmtStarted(info));
      return;
    }
    const text = fmtCard(this.buildCardState());
    const kb = this.currentKeyboard();
    this.lastCardSig = `${text} ${JSON.stringify(kb)}`;
    this.cardMessageId = await this.tg.sendCard(text, kb);
  }

  async announceHalt(reason: 'circuit-breaker' | 'signal', flat: boolean | null): Promise<void> {
    this.stopRefresh();
    if (this.dashboard) await this.refreshCard();
    await this.tg.sendMessage(fmtHalted(reason, flat));
  }

  /** Start periodic updates: edit the card in place (dashboard) or push heartbeats. */
  startRefresh(): void {
    if (this.timer) return;
    const ms = this.dashboard ? (this.dashboard.refreshMs ?? 15_000) : this.heartbeatMs;
    if (ms <= 0) return;
    this.timer = setInterval(() => {
      if (this.dashboard) {
        void this.refreshCard();
      } else {
        void this.tg.sendMessage(
          fmtHeartbeat({
            elapsedMs: Date.now() - this.startedAt,
            pnl: this.latestEquity?.pnl ?? 0,
            equity: this.latestEquity?.equity ?? 0,
            net: [...this.netByPair.entries()],
            hedges: this.hedges,
          }),
        );
      }
    }, ms);
    // Don't keep the process alive solely for the timer.
    this.timer.unref?.();
  }

  stopRefresh(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  // -- Dashboard internals --------------------------------------------------

  private buildCardState(): CardState {
    const d = this.dashboard;
    return {
      live: this.live,
      elapsedMs: Date.now() - this.startedAt,
      pnl: this.latestEquity?.pnl ?? 0,
      equity: this.latestEquity?.equity ?? 0,
      hedges: this.hedges,
      rows: d ? readQuoteRows(d.quotesPath) : [],
      pulled: d ? d.controls.isPulled() : false,
      killed: d ? d.controls.isKilled() : false,
    };
  }

  private currentKeyboard(): InlineKeyboard {
    const d = this.dashboard;
    return dashboardKeyboard({
      pulled: d ? d.controls.isPulled() : false,
      killed: d ? d.controls.isKilled() : false,
      confirmingKill: this.confirmingKill,
    });
  }

  /** Edit the live card in place, skipping no-op edits (avoids "not modified"). */
  private async refreshCard(): Promise<void> {
    if (!this.dashboard || this.cardMessageId == null) return;
    const text = fmtCard(this.buildCardState());
    const kb = this.currentKeyboard();
    const sig = `${text} ${JSON.stringify(kb)}`;
    if (sig === this.lastCardSig) return;
    this.lastCardSig = sig;
    await this.tg.editCard(this.cardMessageId, text, kb);
  }

  /** Handle one inbound text command. Public for testing. */
  async handleCommand(cmd: TelegramCommand): Promise<void> {
    if (!this.dashboard) return;
    if (cmd.chatId !== this.tg.authorizedChatId) return; // ignore strangers
    const text = cmd.text.trim().toLowerCase();
    if (text === '/status' || text === '/start' || text.startsWith('/status')) {
      // Repost a fresh card and retarget edits to it, so the dashboard follows you.
      this.confirmingKill = false;
      const body = fmtCard(this.buildCardState());
      const kb = this.currentKeyboard();
      const id = await this.tg.sendCard(body, kb);
      if (id != null) {
        this.cardMessageId = id;
        this.lastCardSig = `${body} ${JSON.stringify(kb)}`;
      }
    }
  }

  /**
   * Handle one inbound button tap. Public for testing. Side effects are
   * halt-only (pull/resume/kill) and only ever fire for the authorized chat.
   */
  async handleCallback(cb: TelegramCallback): Promise<void> {
    if (!this.dashboard) return;
    if (cb.chatId !== this.tg.authorizedChatId) return; // ignore strangers; no ack
    const controls = this.dashboard.controls;
    const action = cb.data.startsWith('mm:') ? cb.data.slice(3) : '';
    let toast = '';
    switch (action) {
      case 'pull':
        controls.pull();
        this.confirmingKill = false;
        toast = 'Quoting paused';
        break;
      case 'resume':
        controls.resume();
        this.confirmingKill = false;
        toast = 'Quoting resumed';
        break;
      case 'kill':
        this.confirmingKill = true; // two-tap: arm the confirm buttons
        toast = 'Tap Confirm to halt';
        break;
      case 'confirm_kill':
        controls.kill();
        this.confirmingKill = false;
        toast = 'Kill switch tripped';
        break;
      case 'cancel':
        this.confirmingKill = false;
        toast = 'Cancelled';
        break;
      case 'refresh':
        this.confirmingKill = false;
        toast = 'Refreshed';
        break;
      default:
        toast = '';
    }
    await this.tg.answerCallback(cb.callbackQueryId, toast || undefined);
    // Update the card the tap came from (controls stay on the live message).
    this.cardMessageId = cb.messageId;
    await this.refreshCard();
  }

  /** Run the inbound poll loop until aborted. No-op outside dashboard mode. */
  async runControlLoop(signal: AbortSignal): Promise<void> {
    if (!this.dashboard) return;
    let offset = 0;
    while (!signal.aborted) {
      const { commands, callbacks, nextOffset } = await this.tg.poll(offset, 30, signal);
      offset = nextOffset;
      for (const c of commands) await this.handleCommand(c);
      for (const cb of callbacks) await this.handleCallback(cb);
    }
  }
}
