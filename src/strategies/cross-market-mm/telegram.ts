/**
 * Cross-market-mm ↔ Telegram glue.
 *
 * Subscribes to the Recorder event stream and turns it into a live channel:
 *   - a one-line "started" / "halted" lifecycle message
 *   - an instant ping each time a fill is hedged (the interesting moment)
 *   - a periodic heartbeat with PnL, equity, per-pair net delta, hedge count
 *
 * Noisy events (`order` on every cancel-replace, `snapshot` every tick) are NOT
 * pinged — they only update the in-memory state the heartbeat summarizes.
 *
 * The formatters are pure and unit-tested; the class is a thin stateful shell
 * around a TelegramClient. Telegram is a read-side mirror — nothing here can
 * place or move funds, and a send failure is swallowed by the client.
 */

import type { TelegramClient } from '../../core/telegram/client.js';
import type { ReplicatorEvent, TimestampedEvent } from './recorder.js';

type HedgeEvent = Extract<ReplicatorEvent, { kind: 'hedge' }>;

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

// -- Stateful broadcaster ---------------------------------------------------

export class CrossMarketTelegram {
  private latestEquity: { pnl: number; equity: number } | null = null;
  private readonly netByPair = new Map<string, number>();
  private hedges = 0;
  private readonly startedAt = Date.now();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly tg: TelegramClient,
    private readonly heartbeatMs: number = 60_000,
  ) {}

  /** Fold one event into live state; ping on a successful hedge. */
  onEvent(ev: TimestampedEvent): void {
    switch (ev.kind) {
      case 'snapshot':
        this.netByPair.set(ev.pair, ev.net);
        break;
      case 'equity':
        this.latestEquity = { pnl: ev.pnl, equity: ev.equity };
        break;
      case 'hedge':
        if (ev.success) this.hedges += 1;
        void this.tg.sendMessage(fmtHedge(ev));
        break;
      // 'order' / 'run' are intentionally not pinged.
    }
  }

  async announceStart(info: StartInfo): Promise<void> {
    await this.tg.sendMessage(fmtStarted(info));
  }

  async announceHalt(reason: 'circuit-breaker' | 'signal', flat: boolean | null): Promise<void> {
    this.stopHeartbeat();
    await this.tg.sendMessage(fmtHalted(reason, flat));
  }

  startHeartbeat(): void {
    if (this.heartbeatMs <= 0 || this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      void this.tg.sendMessage(
        fmtHeartbeat({
          elapsedMs: Date.now() - this.startedAt,
          pnl: this.latestEquity?.pnl ?? 0,
          equity: this.latestEquity?.equity ?? 0,
          net: [...this.netByPair.entries()],
          hedges: this.hedges,
        }),
      );
    }, this.heartbeatMs);
    // Don't keep the process alive solely for the heartbeat.
    this.heartbeatTimer.unref?.();
  }

  stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}
