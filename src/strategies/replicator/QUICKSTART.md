# Quickstart — see cross-venue market-making in <10 minutes (no real money)

This is the fast path: clone → dry-run, and watch the bot mirror a Polymarket
book onto Limitless and fire a hedge — **signing nothing, funding nothing**.
When you're ready for real money, go to **[GO-LIVE.md](./GO-LIVE.md)**. For the
full reference, see **[SKILL.md](./SKILL.md)**.

You only need a **Limitless HMAC token** for this (read-only here). No Polymarket
funding, no deposit wallet, no on-chain approvals.

## 1. Install + secrets (~3 min)

```bash
npm install
cp .env.example .env && chmod 600 .env
```

Set just these in `.env` (leave `DRY_RUN=true`):

```
PRIVATE_KEY=0x...        # any dedicated EOA — unfunded is fine for dry-run
LMTS_TOKEN_ID=...        # Limitless scoped HMAC token id
LMTS_TOKEN_SECRET=...    # Limitless scoped HMAC token secret (base64)
```

Get the token: limitless.exchange → connect wallet → API token modal →
*API Tokens* tab → Derive → copy `tokenId` + `secret`.

## 2. Pick a pair (~2 min)

```bash
npm run replicator:find-pairs
cp src/strategies/replicator/config.example.yaml ./replicator.config.yaml
```

Paste one shortlisted pair into `market_pairs` in `replicator.config.yaml`.
Leave `order_size: 5`, `poly_signature_type: 3`, `dry_run: true`. For dry-run you
don't even need a real `poly_funder` (no orders are signed) — though setting it
makes `status` work later.

## 3. Watch it think (~2 min)

```bash
npm run replicator
```

A healthy dry-run boot logs the DRY_RUN banner, resolves both markets, connects
the Poly WS, then fires a cancel-replace cycle on every Polymarket tick:

```
INFO Limitless market resolved        { yes: '…', exchange: '0x…' }
INFO Polymarket assets resolved       { yes: '…', no: '…' }
INFO Poly WS connected                { count: 2 }
INFO [DRY_RUN] would cancelAll        { marketSlug: '…' }
INFO [DRY_RUN] would createOrder      { side: 'YES', price: 0.61, usdAmount: 3.05, orderType: 'GTC' }
INFO [DRY_RUN] would createOrder      { side: 'NO',  price: 0.36, usdAmount: 1.80, orderType: 'GTC' }
```

That's the maker side: it's quoting one margin step inside the live Polymarket
book. Ctrl-C to stop.

## 4. See the hedge fire (~1 min)

Quotes might rest a while before a real taker hits them, so inject a synthetic
fill to watch the **full cross-venue round-trip** through the real pipeline:

```bash
SIMULATE_FILL=YES:5 DRY_RUN=true npm run replicator    # Ctrl-C after a few ticks, then:
npm run replicator:analyze
```

You'll see the hedger detect a 5-share YES exposure and fire the offsetting NO
hedge on Polymarket (logged, not sent), returning the book to delta-flat. That's
the whole idea: **earn the Limitless spread, stay flat by hedging on Polymarket.**

---

That's the strategy, end to end, for $0. When you want it live with real
fills and real hedges, continue to **[GO-LIVE.md](./GO-LIVE.md)**.
