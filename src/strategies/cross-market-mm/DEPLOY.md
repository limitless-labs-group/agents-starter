# Deploying cross-market-mm to a host (Railway, etc.)

Run the bot as a persistent worker so it keeps quoting and hedging when your laptop
is closed. This covers any long-running host; Railway is the worked example.

**Do the one-time local setup first** (`init` -> `setup-poly` -> fund the wallets) on
your own machine. The host just runs the already-set-up bot, it does not onboard you.

## What runs

The **deterministic bot, not an agent**. It is a long-running Node worker. The
repo's `Procfile` declares it:

```
worker: npm run cross-market-mm
```

If your host ignores the Procfile, set the **start command** to
`npm run cross-market-mm` in the service settings. The repo's default `npm start`
runs a different entrypoint, so you must override it either way.

## 1. Secrets as environment variables

`.env` is gitignored, so set these in the host's encrypted env (never commit them):

| Var | What |
|---|---|
| `PRIVATE_KEY` | your funded wallet key (also derives the gasless Polymarket deposit wallet) |
| `LMTS_TOKEN_ID` | Limitless API token id |
| `LMTS_TOKEN_SECRET` | Limitless API HMAC secret |
| `DRY_RUN` | `true` to rehearse, `false` to go live |
| `LOG_LEVEL` | e.g. `info` |

Plus any Telegram vars you set locally if you want operate/kill from your phone. The
one-time relayer key is **not** needed at runtime, only for `setup-poly`, which you
already ran locally.

## 2. The config (the part hosts get wrong)

`cross-market-mm.config.yaml` is gitignored but holds **no secrets**, just your pair,
sizes, risk limits, and the deposit-wallet address. Two ways to get it onto the host:

- **Commit it to your deploy fork** (simplest): `git add -f cross-market-mm.config.yaml`.
  Safe, no secrets in it. The host then builds with it in place.
- **Or** set `CROSS_MARKET_MM_CONFIG_PATH` to a path you provide on the host.

## 3. A persistent volume for the data dir

The bot writes its flat-file contract (`quotes.json`, `positions.json`,
`fills.ndjson`, `kill.flag`, `pull.flag`). On an ephemeral host these vanish on every
restart, and the control panel reads them. Attach a **volume** and point the bot at it:

```
CROSS_MARKET_MM_DATA_DIR=/data     # = your volume's mount path
```

## 4. (Optional) the control panel as a second service

The panel is a **separate Python service** (`control_panel.py`) that reads the same
flat files, it does not run or talk to the bot. Deploy it as a second service on the
**same volume**, with `QUOTES_PATH` / `POSITIONS_PATH` / `AGENT_LOG` / `KILL_SWITCH` /
`PULL_SWITCH` pointed at the volume's files. The Limitless Academy **Market Maker
Bootcamp (Day 3)** documents this exact Railway setup.

## Go-live checklist

1. One-time local setup done (`init`, `setup-poly`, wallets funded).
2. Secrets set as env vars; `DRY_RUN=false` when you mean it.
3. Config present (committed to your fork, or via `CROSS_MARKET_MM_CONFIG_PATH`).
4. Volume attached and `CROSS_MARKET_MM_DATA_DIR` set.
5. Start command is `npm run cross-market-mm`.
6. Watch the logs for boot + the `operator-panel feed -> ... ABSOLUTE dir: ...` line,
   then point the panel (or its env vars) at that dir.

## Running a different strategy

The `Procfile` defaults to `cross-market-mm`. To deploy another strategy in this kit,
change the worker line (e.g. `worker: npm run oracle-arb`) or the host start command.
