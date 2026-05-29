# Demo — exact, reproducible end-to-end

The precise command sequence to reproduce a full replicator run, twice: once
with **no money** (Part A, ~5 min) and once **live on a real pair** (Part B).
Every command is copy-paste from the repo root (`agents-starter/`). Concepts and
troubleshooting are in **[SKILL.md](./SKILL.md)**.

---

## Part A — no-money demo (cross-venue MM in one pipeline)

Proves the whole maker→hedge→flat loop without funding anything. Needs only a
Limitless HMAC token in `.env`.

```bash
npm install
cp .env.example .env && chmod 600 .env
#   set PRIVATE_KEY, LMTS_TOKEN_ID, LMTS_TOKEN_SECRET. Leave DRY_RUN=true.

# 1. Pick a pair from the live shortlist and configure.
npm run replicator:find-pairs
cp src/strategies/replicator/config.example.yaml ./replicator.config.yaml
#   paste one shortlisted pair into market_pairs; order_size: 5; dry_run: true

# 2. Dry-run: watch cancel-replace quote inside the Polymarket book.
npm run replicator
#   expect: markets resolve → Poly WS connected → [DRY_RUN] would cancelAll /
#   would createOrder (YES + NO) every tick. Ctrl-C to stop.

# 3. Force the full round-trip through the real hedger and summarize it.
SIMULATE_FILL=YES:5 DRY_RUN=true npm run replicator   # Ctrl-C after ~20s, then:
npm run replicator:analyze
#   expect: a synthetic 5-share YES fill → hedger fires offsetting NO hedge on
#   Polymarket (logged) → book returns delta-flat. analyze prints orders placed,
#   fills inferred, how flat the book stayed, hedges fired.
```

Part A is the demo to show someone the strategy with zero risk.

---

## Part B — live validation on a real pair

The reproducible recipe for a small live run that proves enter → hedge → exit on
a real market. Requires real funds (see GO-LIVE.md). Keep `order_size: 5`.

### One-time setup (per wallet)

```bash
#   add RELAYER_API_KEY + RELAYER_API_KEY_ADDRESS to .env first.
npm run replicator:setup-poly
#   → prints deposit-wallet address. Set in replicator.config.yaml:
#       poly_funder: "0x…"   poly_signature_type: 3
#   then fund: Base USDC+ETH → EOA; pUSD → the deposit wallet.

npm start approve <your-limitless-slug>     # one-time per exchange
```

### Per validation run

```bash
# 1. Confirm everything's wired.
npm run replicator:preflight        # must exit 0
npm run replicator:status           # confirm USDC on Base, pUSD in deposit wallet

# 2. Go live small (dry_run: false in YAML, DRY_RUN unset/false in .env).
npm run replicator
#   let it quote and (ideally) take a fill; watch for a HEDGE log line.
#   if no taker comes, that pair is illiquid on Limitless — try another.

# 3. Verify it stayed hedged mid-run (separate terminal).
npm run replicator:status
#   per-pair "net … (flat)" means the hedge kept you delta-neutral.

# 4. Exit to flat on BOTH venues.
#    Either Ctrl-C the bot (flatten_on_stop sells to flat automatically), or:
npm run replicator:close
#   expect per pair: Limitless YES/NO → (FLAT), Polymarket YES/NO → (FLAT),
#   ending "All configured pairs flat on both venues."

# 5. Confirm flat and review.
npm run replicator:status           # net ≈ 0, no live orders, dust positions only
npm run replicator:analyze          # round-trip summary for the run
```

### Acceptance criteria for a validated run

- Quotes rested on Limitless and at least one filled (or `SIMULATE_FILL` for the
  hedge-path proof on an illiquid pair).
- The hedger fired and `status` showed per-pair **net ≈ 0** (delta-flat).
- `replicator:close` (or Ctrl-C flatten-on-stop) ended **flat on both venues**.
- Realized PnL for the run ≥ −$10 (the `max_loss_usd` breaker bound).

Repeat across 2–3 distinct pairs (e.g. grouped/neg-risk winner markets) to
confirm the flow holds across market types, including the separate neg-risk
exchange approval.

---

## Validation log

Record of runs used to validate this skill (newest first). Each line: date,
pair(s), what was proven.

- 2026-05-29 (2nd run, throttled) — same 3 pairs, `min_requote_ms: 2000`.
  **Full enter→hedge→exit proven live on Knicks** (2nd distinct pair): the
  resting Limitless quote filled **+4.93 YES**, the hedger bought the offsetting
  NO on Polymarket, and the pair held delta-flat (avg net exposure |0.02|, flat
  89% of ticks). Closed to flat on both venues via flatten-on-stop +
  `replicator:close`; `replicator:status` verified 0 positions / 0 orders / net
  0.00. analyze: 3 pairs, 78m, **net PnL −$0.10** (worst −$3.48), captured in
  `./data`. Throttle confirmed: 429s ~1967/1.75h (unthrottled) → a residual
  burst + ~1–3/min (throttled). Finding: the hedger **stale-read stacked** —
  one 4.9 fill drew 3 hedges ($8.4 Poly buys for a ~$3.4 need) because
  `hedge_interval` (5s) < the Poly data-api settle lag → added the
  `hedge_settle_ms` gate (default 12s, with a unit test). Net still ended flat;
  the gate prevents the over-trade.
- 2026-05-29 (1st run, unthrottled) — 3 neg-risk "winner" pairs
  (Hurricanes/Spurs/Knicks), `order_size: 5`, `margin_bps: 30`. Live ENTER
  proven: ~7k real orders across all 3, Hurricanes resting at the touch
  (0.55/0.56). EXIT proven: Ctrl-C → flatten-on-stop + `replicator:flatten` +
  `replicator:status` → 0 orders / 0 positions / net 0.00, **zero fills, zero
  loss**. Finding: a sustained unthrottled multi-pair run trips the Limitless
  API rate-limit (429/1015) → added the `min_requote_ms` throttle.
- 2026-05-28 — UCL "Arsenal to win" (Limitless `arsenal-…` ↔ Polymarket
  `will-arsenal-win-the-202526-champions-league`), `order_size: 5`. First real
  cross-venue hedge filled live (Limitless YES maker fill → Polymarket NO FAK
  hedge), held delta-flat, then **closed to flat on both venues** via
  `replicator:close` after adding the CTF sell-approval. Neg-risk/grouped market.
