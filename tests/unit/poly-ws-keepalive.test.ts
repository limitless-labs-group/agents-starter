/**
 * Polymarket market-stream keepalive.
 *
 * The stream requires a text frame `PING` every 10s (server answers `PONG`);
 * protocol ping frames don't count. Because PONGs are messages, a socket
 * with no inbound traffic for `staleMs` is dead, not quiet, and gets closed
 * so the reconnect loop can resubscribe.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { attachKeepalive, KEEPALIVE_PING_MS, KEEPALIVE_STALE_MS } from '../../src/core/polymarket/ws.js';

function fakeSocket(readyState = 1) {
  return {
    readyState,
    sent: [] as string[],
    closed: 0,
    send(data: string) {
      this.sent.push(data);
    },
    close() {
      this.closed += 1;
    },
  };
}

describe('attachKeepalive', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('sends a text PING every pingMs while the socket is open', () => {
    const ws = fakeSocket();
    const ka = attachKeepalive(ws, { pingMs: 10_000, staleMs: 30_000 });
    ws.sent.length = 0;
    vi.advanceTimersByTime(10_000);
    ka.touch();
    vi.advanceTimersByTime(10_000);
    ka.touch();
    expect(ws.sent).toEqual(['PING', 'PING']);
    ka.stop();
  });

  it('does not send on a socket that is not OPEN', () => {
    const ws = fakeSocket(0);
    const ka = attachKeepalive(ws, { pingMs: 10_000, staleMs: 30_000 });
    vi.advanceTimersByTime(10_000);
    expect(ws.sent).toEqual([]);
    ka.stop();
  });

  it('closes the socket once nothing (not even PONG) arrives for staleMs', () => {
    const ws = fakeSocket();
    const ka = attachKeepalive(ws, { pingMs: 10_000, staleMs: 30_000 });
    vi.advanceTimersByTime(30_000); // three pings, no touch
    expect(ws.closed).toBe(0);
    vi.advanceTimersByTime(10_000); // 40s silent > 30s
    expect(ws.closed).toBe(1);
    vi.advanceTimersByTime(60_000); // timer stopped itself: no second close, no more pings
    expect(ws.closed).toBe(1);
    expect(ws.sent.length).toBe(3);
    ka.stop();
  });

  it('touch() keeps a quiet-but-alive socket open', () => {
    const ws = fakeSocket();
    const ka = attachKeepalive(ws, { pingMs: 10_000, staleMs: 30_000 });
    for (let i = 0; i < 12; i++) {
      vi.advanceTimersByTime(10_000);
      ka.touch(); // PONG
    }
    expect(ws.closed).toBe(0);
    expect(ws.sent.length).toBe(12);
    ka.stop();
  });

  it('defaults match the documented 10s cadence', () => {
    expect(KEEPALIVE_PING_MS).toBe(10_000);
    expect(KEEPALIVE_STALE_MS).toBeGreaterThan(KEEPALIVE_PING_MS * 2);
  });
});
