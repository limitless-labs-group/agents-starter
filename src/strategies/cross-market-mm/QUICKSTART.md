# Quickstart — cross-market market making, live on both venues

Quote a market on **Limitless** and hedge your fills on **Polymarket** to stay
delta-neutral — earning the cross-venue spread plus Limitless maker rebates +
LP rewards. This is the real thing: real orders, real money, both chains. Budget
**~20–30 minutes** the first time — most of it is funding and one-time wallet
setup, not running commands. Full reference + troubleshooting: **[SKILL.md](./SKILL.md)**.

> Real money on Base + Polygon. Use a **dedicated** wallet, never your main.
> Start with a small `order_size` (5). A `-$10` loss circuit-breaker is on by
> default; Ctrl-C and the breaker both flatten to flat on both venues.

## What you need

- **One dedicated EOA private key** — it signs on both chains and controls
  everything (your EOA on Base + a key-less Polymarket deposit wallet on Polygon;
  no second key). See [SKILL.md §2](./SKILL.md) for the one-key wallet model.
- **Two API tokens** (not wallet keys):
  - **Limitless scoped HMAC token** — limitless.exchange → connect wallet → API
    token modal → *API Tokens* → Derive → `LMTS_TOKEN_ID` + `LMTS_TOKEN_SECRET`.
    Full flow: [Limitless Authentication](https://docs.limitless.exchange/developers/authentication).
  - **Polymarket relayer API key** — from the [Polymarket builder dashboard](https://docs.polymarket.com/builders/overview)
    → `RELAYER_API_KEY` + `RELAYER_API_KEY_ADDRESS` (your EOA address). For the
    [gasless](https://docs.polymarket.com/trading/gasless) setup only.
- **Funds:** Base **USDC** (collateral) + ~$1–2 **ETH** (gas) on your EOA;
  [**pUSD**](https://docs.polymarket.com/concepts/pusd) on Polygon held **in the
  deposit wallet** (deployed in step 2).

## 1. Install + credentials

```bash
git clone https://github.com/limitless-labs-group/agents-starter.git
cd agents-starter && npm install
cp .env.example .env && chmod 600 .env
# set PRIVATE_KEY, LMTS_TOKEN_ID, LMTS_TOKEN_SECRET, RELAYER_API_KEY, RELAYER_API_KEY_ADDRESS
```

## 2. Deploy your Polymarket deposit wallet (gasless, ~1 min)

Polymarket's CLOB rejects a Gnosis Safe maker, so API trading uses a key-less
[**deposit wallet**](https://docs.polymarket.com/trading/deposit-wallets)
(POLY_1271, signature type 3) derived from your EOA:

```bash
npm run cross-market-mm:setup-poly
```

It derives + deploys the deposit wallet and approves **pUSD** (buy) **and** CTF
(sell, so you can exit to flat). It prints the deposit-wallet address — set it in
`cross-market-mm.config.yaml`:

```yaml
poly_funder: "0x...the printed deposit-wallet address"
poly_signature_type: 3
```

## 3. Fund (most of the wall-clock time)

- **Base** → your EOA: USDC (collateral) + ~$1–2 ETH (gas).
- **Polygon** → the **deposit-wallet address** from step 2: pUSD.
  - pUSD anywhere else (your EOA, a Safe, your Polymarket UI login) is **not**
    CLOB buying power. It must be in the deposit wallet.

```bash
npm run cross-market-mm:status   # confirms Base USDC + the deposit wallet's pUSD landed
```

`status` is the only place to see the deposit wallet's pUSD + positions — they
don't appear in the Polymarket UI.

## 4. Pick a pair + configure

```bash
npm run cross-market-mm:find-pairs   # liquidity-ranked cross-venue shortlist
```

Paste one shortlisted pair into `market_pairs` in `cross-market-mm.config.yaml`,
keep `order_size: 5` to start. **Verify both markets resolve on identical
criteria** — same asset, threshold, UTC moment, source. Title overlap is not
enough.

## 5. Approve the Limitless exchange (one-time, per exchange)

```bash
npm start approve <your-limitless-slug>
```

Approves USDC (buy) + CTF (sell) for that market's exchange.
[Neg-risk](https://docs.limitless.exchange/user-guide/negrisk-overview)
(grouped/winner) markets use a separate exchange and need their own approve —
preflight tells you if it's missing.

## 6. Preflight, then go live

```bash
npm run cross-market-mm:preflight    # validates auth, funding, sig type, approvals, pairs
```

A green preflight means the next live run places real orders with no surprise
rejections. (Optional sanity check first: leave `dry_run: true` and run
`npm run cross-market-mm` once — it logs intents and signs nothing, so you can
confirm it boots, resolves both markets, and quotes before risking a cent.)

Then flip `dry_run: false` in `cross-market-mm.config.yaml` and run it live:

```bash
npm run cross-market-mm
```

What a healthy live run looks like:

```
INFO Polymarket auth OK            { funder: 0x7Ec6…, signatureType: 3 }
INFO Limitless market resolved     { yes: '…', exchange: '0x…' }
INFO Poly WS connected             { count: 2 }
INFO createOrder placed            { side: 'YES', price: 0.55, size: 5, orderId: '…' }
INFO createOrder placed            { side: 'NO',  price: 0.44, size: 5, orderId: '…' }
# …cancel-replace repeats every Polymarket tick. When a Limitless taker fills you:
INFO HEDGE                         { buy: 'NO', shares: '5.00', usdc: '2.20' }
INFO hedge filled
```

Your quotes rest until a Limitless taker hits them — fills aren't instant, and a
thin pair can sit a while. Watch the first live minutes.

## 7. Operate + exit

```bash
npm run cross-market-mm:status     # cross-venue portfolio + per-pair net delta, any time
npm run cross-market-mm:close      # exit to flat on BOTH venues (cancel + sell/redeem)
npm run cross-market-mm:analyze    # summarize a run: orders, fills, delta-flatness, hedges, PnL
```

**Stopping safely:** Ctrl-C — or a tripped `max_loss_usd` breaker — cancels all
resting orders **and** sells inventory to flat on both venues (`flatten_on_stop`,
default on). `cross-market-mm:close` is the deliberate wind-down (idempotent).
If anything looks wrong: **halt, flatten, check `status`** — don't keep bleeding.

## Economics

On Limitless you're the **maker**, and makers pay
[**no fee**](https://docs.limitless.exchange/user-guide/fees) — your only direct
cost is the Polymarket hedge's taker fee. Profit comes from the cross-venue
spread + two daily-USDC reward programs:
[maker rebates](https://docs.limitless.exchange/user-guide/maker-rebates) (on
filled maker orders) and [LP rewards](https://docs.limitless.exchange/user-guide/lp-rewards)
(for resting near the midpoint). At `order_size: 5` you earn ~nothing from the
reward programs — that size is for proving the machinery; size up (and target
eligible markets) to actually farm. The binding constraint is fill rate, not
fees. See [SKILL.md §9](./SKILL.md) for the full math.
