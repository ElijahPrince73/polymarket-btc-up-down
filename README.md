# Polymarket BTC 15m Assistant

A real-time console trading assistant for Polymarket **"Bitcoin Up or Down" 15-minute** markets.

It combines:
- Polymarket market selection + UP/DOWN prices + liquidity
- Polymarket live WS **Chainlink BTC/USD CURRENT PRICE** (same feed shown on the Polymarket UI)
- Fallback to on-chain Chainlink (Polygon) via HTTP/WSS RPC
- Binance spot price for reference
- Short-term TA snapshot (Heiken Ashi, RSI, MACD, VWAP, Delta 1/3m)
- A simple live **Predict (LONG/SHORT %)** derived from the assistant’s current TA scoring

## Requirements

- Node.js **18+** (recommended: latest LTS)
- npm (comes with Node)

## Install

```bash
npm install
```

## Configuration

This project reads configuration from environment variables.

You can set them in your shell, or create a `.env` file and load it using your preferred method.

### Polymarket

- `POLYMARKET_AUTO_SELECT_LATEST` (default: `true`)
  - When `true`, automatically picks the latest 15m market.
- `POLYMARKET_SERIES_ID` (default: `10192`)
- `POLYMARKET_SERIES_SLUG` (default: `btc-up-or-down-15m`)
- `POLYMARKET_SLUG` (optional)
  - If set, the assistant will target a specific market slug.
- `POLYMARKET_LIVE_WS_URL` (default: `wss://ws-live-data.polymarket.com`)

### Chainlink on Polygon (fallback)

- `CHAINLINK_BTC_USD_AGGREGATOR`
  - Default: `0xc907E116054Ad103354f2D350FD2514433D57F6f`

HTTP RPC:
- `POLYGON_RPC_URL` (default: `https://polygon-rpc.com`)
- `POLYGON_RPC_URLS` (optional, comma-separated)
  - Example: `https://polygon-rpc.com,https://rpc.ankr.com/polygon`

WSS RPC (optional but recommended for more real-time fallback):
- `POLYGON_WSS_URL` (optional)
- `POLYGON_WSS_URLS` (optional, comma-separated)

## Run

```bash
npm start
```

## Notes / Troubleshooting

- If you see no Chainlink updates:
  - Polymarket WS might be temporarily unavailable. The bot falls back to Chainlink on-chain price via Polygon RPC.
  - Ensure at least one working Polygon RPC URL is configured.
- If the console looks like it “spams” lines:
  - The renderer uses `readline.cursorTo` + `clearScreenDown` for a stable, static screen, but some terminals may still behave differently.

## Safety

This is not financial advice. Use at your own risk.

created by @krajekis
