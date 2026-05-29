# Go live — real money, both venues (~20–30 minutes, honest)

This picks up where **[QUICKSTART.md](./QUICKSTART.md)** left off (you've done a
clean dry-run). Going live means funding two chains and deploying a Polymarket
deposit wallet. Budget ~20–30 minutes the first time — most of it is moving
funds and waiting for transfers, not running commands. Full reference and
troubleshooting live in **[SKILL.md](./SKILL.md)**.

> Real money on Base + Polygon. Dedicated wallet only. Start with `order_size:
> 5`. At this smoke-test size you earn ~nothing from the reward programs (LP
> rewards have a per-market minimum size) — the point of a first live run is to
> prove the machinery, not to profit. See SKILL §9 for the real economics.

## What "live" requires that dry-run didn't

- A **Polymarket deposit wallet** (key-less ERC-1271 proxy from your EOA) —
  because the CLOB rejects Gnosis Safe makers. One command deploys it.
- A **relayer key** in `.env` (`RELAYER_API_KEY` + `RELAYER_API_KEY_ADDRESS`)
  from the Polymarket builder dashboard — used only for gasless setup.
- **Funds:** Base USDC + a little ETH on your EOA; **pUSD inside the deposit
  wallet** on Polygon.
- A **one-time Limitless exchange approval** for your pair's market.

Read **SKILL.md §2 (the wallet model)** once before funding — the "pUSD must be
in the deposit wallet, which is invisible in the UI" point is the thing people
get wrong.

## Steps

```bash
# 1. Add the relayer key to .env (from the Polymarket builder dashboard):
#      RELAYER_API_KEY=...
#      RELAYER_API_KEY_ADDRESS=0x...   (your PRIVATE_KEY's address)

# 2. Deploy the deposit wallet + approvals (gasless, ~1 min):
npm run cross-market-mm:setup-poly
#    Prints your deposit-wallet address. Put it in cross-market-mm.config.yaml:
#      poly_funder: "0x...that address"
#      poly_signature_type: 3
#    It approves BOTH pUSD (buy) and CTF (sell) so you can later exit to flat.

# 3. Fund (this is most of the wall-clock time):
#    • Base:    USDC (collateral) + ~$1–2 ETH (gas) → your EOA
#    • Polygon: pUSD → the DEPOSIT-WALLET address from step 2 (NOT your EOA/Safe/UI login)
#    Confirm pUSD landed in the right place:
npm run cross-market-mm:status

# 4. Approve the Limitless market's exchange (one-time, per exchange, ~$0.01 gas):
npm start approve <your-limitless-slug>
#    Neg-risk (sports/election "winner") markets use a separate exchange → own approve.

# 5. Gate on preflight — exits non-zero if anything's wrong:
npm run cross-market-mm:preflight

# 6. Go live, small:
#    set dry_run: false in YAML AND ensure DRY_RUN isn't true in .env, then:
npm run cross-market-mm
```

## What "working" looks like, live

```
INFO Polymarket auth OK            { funder: 0x7Ec6…, signatureType: 3 }
INFO Limitless market resolved     { yes: '…', exchange: '0x…' }
INFO Poly WS connected             { count: 2 }
INFO createOrder placed            { side: 'YES', price: 0.61, size: 5, orderId: '…' }
INFO createOrder placed            { side: 'NO',  price: 0.35, size: 5, orderId: '…' }
# …cancel-replace repeats every Poly tick. When a Limitless taker fills you:
INFO hedge filled                  { buyUsdc: '2.10' }
```

Fills aren't guaranteed — your quotes rest until a Limitless taker hits them, so
an illiquid pair can sit for a while. Watch the first live minutes.

## Operating it

```bash
npm run cross-market-mm:status      # cross-venue portfolio + per-pair net delta, any time
```

`status` is the **only** way to see the deposit wallet's pUSD and Polymarket
positions — they don't appear in the Polymarket UI.

## Stopping safely

- **Ctrl-C** (or a tripped `max_loss_usd` breaker) cancels all resting orders
  AND sells inventory to flat on **both venues** (`flatten_on_stop` is true by
  default) — a stop never leaves unhedged directional inventory.
- **`npm run cross-market-mm:close`** — deliberate wind-down to flat on both venues,
  any time. Idempotent; re-run if a thin book leaves a remainder.
- **`npm run cross-market-mm:flatten`** — cancel resting orders only (doesn't touch
  positions); use after an ungraceful kill.

If anything looks wrong: **halt, flatten, check `status`** — don't keep bleeding.

## First-run cost expectation

A tiny live run (`order_size: 5`, one pair, a few fills) is a smoke test, not a
profit run — expect a few dollars of net cost (the Polymarket hedge taker fee +
cross-venue slippage) as the price of proving fills + hedges + exit end to end.
Your Limitless maker fills are fee-free. See **SKILL.md §9** for the real
economics and the two reward programs (maker rebates + LP rewards) that drive
profit at proper size.
