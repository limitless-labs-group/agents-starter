# Operating guide for AI agents

You are operating a real-money trading-agent repo. **This file is your contract.**
For depth, read `src/strategies/cross-market-mm/SKILL.md` (the strategy manual) and
`SKILL.md` (the framework/SDK reference). You shouldn't need a bespoke prompt beyond
"set up and run cross-market-mm" — everything you need to do it safely is here.

## Install (one line)

```sh
curl -fsSL https://raw.githubusercontent.com/limitless-labs-group/agents-starter/main/install.sh | sh
```

Checks prerequisites, clones, installs, and scaffolds. Then the re-runnable bootstrap
`npm run cross-market-mm:init` walks the rest: credentials → deposit wallet → funding.
Run it, do the one step it asks, run it again.

## Safety contract (non-negotiable)

- **The operator's `PRIVATE_KEY` stays out of your context.** Never ask them to paste it,
  never echo it, never `cat .env`, never read the key back. They place it in `.env`
  themselves; `init` is built to never read secrets.
- **Dedicated wallet only** — confirm with the operator it is not their main wallet.
- **Start in `dry_run`.** Go live (`dry_run: false`) only after a clean `preflight` *and*
  the operator's explicit go-ahead.
- **Confirm before any action that spends gas, moves funds, or goes live.**
- The **loss breaker** and **flatten-on-stop** stay on. If anything looks wrong —
  unexpected loss, an unhedged position, a failed hedge, a stuck order — **halt, flatten,
  and report.** Do not keep bleeding.

## The flow

```
install → init (loop until funded) → find-pairs (pick + VERIFY identical resolution)
        → approve → preflight (gate) → dry run → live (on go-ahead) → monitor → close (flat)
```

When picking a pair: `find-pairs` flags polarity-flipped candidates (negation/direction
mismatch) — heed them, and still confirm both markets resolve on identical criteria (same
asset, threshold, UTC moment, source). Title similarity is not enough.

## Commands (cross-market-mm)

| Command | Purpose |
|---|---|
| `npm run cross-market-mm:init` | Guided, re-runnable setup (scaffold → creds → deposit wallet → funding) |
| `npm run cross-market-mm:deposit` | Print the Polymarket bridge address to fund the deposit wallet (send USDC there → auto-wraps to pUSD). NOT the deposit-wallet address directly |
| `npm run cross-market-mm:find-pairs` | Liquidity-ranked equivalent-market shortlist; flags polarity risk (`-- --json` for machine output you can pick from) |
| `npm run cross-market-mm:preflight` | Validate auth/funding/approvals/pairs — the gate before live (`-- --json` for structured go/no-go; non-zero exit on any critical fail) |
| `npm run cross-market-mm` | Run the bot (`DRY_RUN` default; `dry_run: false` to go live) |
| `npm run cross-market-mm:status` | Cross-venue portfolio + net delta (`-- --json` for machine output) |
| `npm run cross-market-mm:close` | Exit to flat on both venues |

Full command list and troubleshooting: `src/strategies/cross-market-mm/SKILL.md`.

## Monitoring

A live run continuously maintains **`data/cross-market-mm-status.json`** — mode, uptime,
PnL, equity, per-pair net delta, hedge count, last fill, breaker + stop state. Poll it for
a heartbeat and relay it to the operator. Use `cross-market-mm:status -- --json` when you
want a fresh independent read from the venues instead.

## Other strategies

`oracle-arb` (Pyth oracle vs market) and `certainty-closer` (SDK-only, the simplest
example) each have their own `QUICKSTART.md` + `SKILL.md` under `src/strategies/`. They
need only Base + a Limitless token — no Polymarket deposit wallet.
