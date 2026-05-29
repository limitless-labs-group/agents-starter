# Cross-market MM strategy

Cross-venue market-making: mirror Polymarket orderbook liquidity onto Limitless
as resting BUY quotes, hedge fills back on Polymarket. Net delta stays ~flat;
you earn the spread between the two venues plus any Limitless maker rebates.

> [!WARNING]
> **Moves real money on two chains** (Base + Polygon). Reference implementation,
> not production trading infrastructure. **Use a dedicated wallet** and always
> start with `DRY_RUN=true`.

## Where to start

| Doc | For |
|---|---|
| **[QUICKSTART.md](./QUICKSTART.md)** | See it work in <10 min, no real money (dry-run + simulated hedge) |
| **[GO-LIVE.md](./GO-LIVE.md)** | Take it live on both venues — honest ~20–30 min path |
| **[SKILL.md](./SKILL.md)** | Canonical reference: wallet model, full lifecycle, capital math, economics, invariants, troubleshooting |
| **[DEMO.md](./DEMO.md)** | Exact, reproducible end-to-end command sequence |

New here? **[QUICKSTART.md](./QUICKSTART.md)**. Setting up real money? Read
**[SKILL.md §2 (the wallet model)](./SKILL.md)** before funding anything, then
follow **[GO-LIVE.md](./GO-LIVE.md)**.

## Commands

```bash
npm run cross-market-mm:find-pairs    # find equivalent market pairs on both venues
npm run cross-market-mm:setup-poly    # one-time: deploy Polymarket deposit wallet + approvals
npm run cross-market-mm:preflight     # validate auth/funding/approvals/pairs before live
npm run cross-market-mm               # run the bot (DRY_RUN by default)
npm run cross-market-mm:status        # cross-venue portfolio + net delta (read-only)
npm run cross-market-mm:close         # exit to flat on BOTH venues
npm run cross-market-mm:flatten       # cancel resting Limitless orders only
npm run cross-market-mm:analyze       # summarize the latest run
```

## Tests

```bash
npm test
```

Covers quote math (`computeBuyPrices`, `clipPrice`), the hedger (`decideHedge`,
cross-venue netting, dust gate), the recorder, and the risk monitor.

This is a TypeScript port of
[limitless-labs-group/limitless-replicator](https://github.com/limitless-labs-group/limitless-replicator)
(the Python original). See [SKILL.md §10](./SKILL.md) for the material
differences (SDK-based Limitless side, `@polymarket/clob-client-v2` for pUSD,
`poly_signature_type`).
