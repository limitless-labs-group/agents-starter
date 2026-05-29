/**
 * Recorder writes valid append-only JSONL and tolerates use-after-close.
 */

import { afterEach, describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Recorder } from '../../src/strategies/cross-market-mm/recorder.js';

describe('Recorder', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });
  function tmp(): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-'));
    dirs.push(d);
    return d;
  }

  it('creates the data dir + a cross-market-mm-*.jsonl file', () => {
    const dir = path.join(tmp(), 'nested');
    const r = new Recorder(dir);
    expect(fs.existsSync(dir)).toBe(true);
    expect(path.basename(r.filePath)).toMatch(/^cross-market-mm-.*\.jsonl$/);
    r.close();
  });

  it('writes one JSON line per record, each with a numeric timestamp', async () => {
    const r = new Recorder(tmp());
    r.record({ kind: 'run', dryRun: true, pairs: 1, orderSize: 5, marginBps: 100 });
    r.record({ kind: 'order', pair: 's', side: 'YES', price: 0.6, size: 5, orderId: 'x' });
    r.close();
    await new Promise((res) => setTimeout(res, 25)); // let the write stream flush

    const lines = fs.readFileSync(r.filePath, 'utf-8').split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);
    const run = JSON.parse(lines[0]);
    expect(run.kind).toBe('run');
    expect(typeof run.t).toBe('number');
    expect(JSON.parse(lines[1])).toMatchObject({ kind: 'order', side: 'YES', price: 0.6 });
  });

  it('record() after close() is a no-op, not a throw', () => {
    const r = new Recorder(tmp());
    r.close();
    expect(() =>
      r.record({ kind: 'run', dryRun: false, pairs: 1, orderSize: 5, marginBps: 100 }),
    ).not.toThrow();
  });
});
