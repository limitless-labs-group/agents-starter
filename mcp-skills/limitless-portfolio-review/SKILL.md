---
name: limitless-portfolio-review
description: Reviews a Limitless account end to end, covering wallet balance and locked collateral, open positions and concentration, resting orders that are stale or not earning, and recent fills, then proposes and executes cleanup cancels. Use when the user asks what they are holding, how their positions look, what orders are still open, why their balance is low, or asks for a portfolio, exposure, or risk review.
---

# Portfolio review

A read-only sweep of the account, followed by an explicit cleanup step. Everything except
the cancels is safe to run unprompted.

## 1. Gather

Call all four, they are independent:

- `get_wallet_balance` for USDC, `openBuyOrderCommitment`, `availableForNewBuyOrders`
- `get_positions` for holdings across the wallets linked to the account
- `get_open_orders` for resting orders, cursor paginated, includes `isEarning` and
  `makerAddress`
- `get_trade_history` for recent fills, cursor paginated

Page through the cursors when there is more than one page. A review built on page one of
open orders is wrong in the way that matters.

## 2. Report

### Balance

Lead with where the money is:

- USDC in the selected trading wallet
- collateral locked by resting BUY orders
- what is actually free for new orders

If `openBuyOrderCommitment` is a large share of the balance, that is usually the answer to
"why can't I place an order", so say it before anything else.

### Positions

Use `tokensBalance` for holdings. Group by market, and flag:

- **Concentration.** Any single market that is a large share of total exposure.
- **Near deadline.** Positions in markets close to resolving.
- **Wallet split.** If entries carry a `makerAddress` or account other than
  `walletContext.selectedTradingWallet`, those are held by another wallet linked to the
  same Limitless account. Do not silently merge them into one number.

`marketValue` and `unrealizedPnl` come from reference prices and the whole snapshot is
cached, so present them as indicative. Never use them to justify an order. For a live
number on a specific market, call `get_orderbook`.

### Open orders

For each resting order report market, side, outcome, price, size, and `isEarning`.

Flag three kinds of order as cleanup candidates:

1. **Not earning** on a market with rewards enabled, meaning the order sits outside the
   band or under the minimum size and is committing collateral for nothing.
2. **Far from the book.** Compare each order's price against `get_orderbook` for that
   market. An order many cents away from the touch is unlikely to fill and is holding
   collateral hostage.
3. **Near deadline.** Resting orders on a market about to resolve.

### Recent activity

Summarise fills from `get_trade_history` by market and side. Rows with a null side are
non-trade events, do not count them as trades.

## 3. Cleanup

Cancels execute immediately. There is no browser approval and no undo.

- List the exact orders you propose to cancel, with the reason for each.
- Wait for the user to confirm.
- Then `cancel_order` per order id, or `cancel_all_orders` when clearing a whole market.
- Report freed collateral by calling `get_wallet_balance` again.

Never cancel as a side effect of a review the user asked for. The review is the deliverable
and the cancels are a separate decision.
