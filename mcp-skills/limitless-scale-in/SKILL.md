---
name: limitless-scale-in
description: Turns a view on a Limitless market into a laddered entry, splitting a budget into several limit orders across a price band instead of one order at the top of the book, then reports cost basis and breakeven probability. Use when the user wants to take a position, buy YES or NO, build into a market, scale in, average into an entry, or set limit orders behind the current price.
---

# Scale into a position

One order at the ask pays the spread and the taker fee on the whole size. A ladder of
resting bids behind the touch fills cheaper when the market comes to you, and fills
nothing when it does not. This skill builds that ladder.

## What you need from the user first

1. **Which market.** Resolve it to one slug with `search_markets` or `get_market_group`.
2. **Which side.** YES (`outcomeIndex: 0`) or NO (`outcomeIndex: 1`).
3. **Total budget in USDC.** Ask. Never infer it from the wallet balance.

If the user gave a thesis rather than a price, read the market's resolution criteria back
to them and confirm the thesis actually matches what resolves the market. Wrong-market
entries are the most common way this goes bad.

If they have a view but have not decided the market, the size, or whether there is any
edge, that is upstream of this skill. Use `limitless-thesis-builder` first and come back
with its output.

## Workflow

### 1. Read the market

`get_market` on the slug. Confirm `orderPlacement.orderable` is true, read the resolution
criteria, and note the deadline. `get_orderbook` for `bestBid`, `bestAsk`, `spread`, and
`bookState`.

### 2. Check the budget is spendable

`get_wallet_balance`. Compare the budget against `availableForNewBuyOrders`. If the budget
exceeds it, say by how much and stop, rather than quietly shrinking the ladder.

### 3. Build the ladder

Default: 5 GTC rungs, flat size, stepping down from `bestBid` for a BUY.

- deepest rung sits meaningfully below the touch, so the ladder has somewhere to fill
- every rung needs `price × shares >= 1`
- `price` strictly between 0 and 1
- at most 10 rungs, that is one approval
- rung cost sums to the budget

Widen or tighten from that default when the book justifies it. A wide `spread` means the
touch is not a real price, so rungs should start lower. A tight two-sided book means the
top rung can sit right behind `bestBid`.

**Optional immediate fill.** If the user wants some size on now, make rung one a `FAK`
order at or slightly above `bestAsk`, and keep the rest `GTC`. Say plainly that the FAK
rung pays the taker fee and the GTC rungs pay nothing if they rest as maker. Some markets
apply a short taker delay, so a marketable order may report back before the fill lands.
Confirm fills with `get_trade_history` rather than assuming.

### 4. Propose

`place_orders` with the whole ladder in one call. Show the table before handing over the
link: price, shares, cost, cumulative cost.

Hand over the `approvalUrl`, note the 10 minute expiry, then poll `check_order_status`.

### 5. Report the entry

After `approved`, report:

| Line | Meaning |
|---|---|
| Cost if every rung fills | total USDC committed |
| Shares if every rung fills | total shares |
| Average entry price | cost divided by shares |
| Breakeven probability | the average entry price, stated as a percentage |
| Max payout | shares × $1 if the outcome resolves in your favour |
| Max loss | the filled cost, if it resolves against you |

The average entry price is the probability you need to be right about. Say it that way. If
the ladder's average entry is 0.62, the position only makes money if the outcome is more
likely than 62%.

## Managing it afterwards

- `get_open_orders` shows which rungs are still resting.
- `cancel_order` or `cancel_all_orders` pull them, and both execute immediately with no
  approval step. Confirm with the user first.
- Pull the ladder when the thesis breaks, not when the price moves against it. A partly
  filled ladder near the deadline is a position, not a work in progress.
