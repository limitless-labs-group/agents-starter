# Cross-market MM strategy

Cross-venue market-making: rest BUY quotes on Limitless, priced off a reference
book on another venue, and hedge any fills there to keep net delta ~flat. The
reference/hedge venue here is Polymarket. You earn the spread between the two
venues plus any Limitless maker rebates.

> [!WARNING]
> **Moves real money on two chains** (Base + Polygon). Reference implementation,
> not production trading infrastructure. **Use a dedicated wallet**, start with a
> small `order_size`, and the `-$10` loss breaker is on by default.

## Where to start

| Doc | For |
|---|---|
| **[QUICKSTART.md](./QUICKSTART.md)** | The onboarding path: install → fund both venues → setup → run live → close (~20–30 min) |
| **[SKILL.md](./SKILL.md)** | Canonical reference: wallet model, full lifecycle, capital math, economics, invariants, troubleshooting |

New here? Start with **[QUICKSTART.md](./QUICKSTART.md)**, and read
**[SKILL.md §2 (the wallet model)](./SKILL.md)** before funding anything.

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
