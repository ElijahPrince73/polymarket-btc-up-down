import express from 'express';
import fs from 'fs';
import path from 'path';
import cors from 'cors';

import { CONFIG } from '../config.js';
import { initializeLedger, getLedger, recalculateSummary } from '../paper_trading/ledger.js'; // To fetch trade data and summary
import { getOpenTrade, getTraderInstance } from '../paper_trading/trader.js'; // To get current open trade status

// Use __dirname polyfill for ES modules
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = process.env.UI_PORT || 3000;

// Middleware
app.use(cors()); // Enable CORS for requests to the UI server
app.use(express.json()); // For parsing JSON bodies

// Serve static UI files (HTML, CSS, JS)
const uiPath = path.join(__dirname, '..', 'ui'); // Assuming ui folder is at src/ui
if (!fs.existsSync(uiPath)) {
  fs.mkdirSync(uiPath); // Create UI directory if it doesn't exist
}
app.use(express.static(uiPath)); // Serve files from ./src/ui/

function bucketEntryPrice(trade) {
  const px = trade?.entryPrice;
  if (typeof px !== 'number' || !Number.isFinite(px)) return 'unknown';
  const cents = px * 100;
  if (cents < 0.5) return '<0.5¢';
  if (cents < 1) return '0.5–1¢';
  if (cents < 2) return '1–2¢';
  if (cents < 5) return '2–5¢';
  if (cents < 10) return '5–10¢';
  return '10¢+';
}

function groupSummary(trades, keyFn) {
  const map = new Map();
  for (const t of trades) {
    const key = String(keyFn(t) ?? 'unknown');
    const cur = map.get(key) || { key, count: 0, pnl: 0 };
    cur.count += 1;
    cur.pnl += (typeof t.pnl === 'number' && Number.isFinite(t.pnl)) ? t.pnl : 0;
    map.set(key, cur);
  }
  return Array.from(map.values()).sort((a, b) => Math.abs(b.pnl) - Math.abs(a.pnl));
}

function computeAnalytics(allTrades) {
  const trades = Array.isArray(allTrades) ? allTrades : [];
  const closed = trades.filter((t) => t && t.status === 'CLOSED');

  const wins = closed.filter((t) => (typeof t.pnl === 'number' && t.pnl > 0));
  const losses = closed.filter((t) => (typeof t.pnl === 'number' && t.pnl < 0));

  const sum = (arr) => arr.reduce((acc, t) => acc + (typeof t.pnl === 'number' ? t.pnl : 0), 0);
  const totalPnL = sum(closed);
  const winPnL = sum(wins);
  const lossPnL = sum(losses); // negative

  const avgWin = wins.length ? (winPnL / wins.length) : null;
  const avgLoss = losses.length ? (lossPnL / losses.length) : null;
  const winRate = closed.length ? (wins.length / closed.length) : null;
  const profitFactor = (lossPnL !== 0) ? (winPnL / Math.abs(lossPnL)) : null;
  const expectancy = closed.length ? (totalPnL / closed.length) : null;

  return {
    overview: {
      closedTrades: closed.length,
      wins: wins.length,
      losses: losses.length,
      totalPnL,
      winRate,
      avgWin,
      avgLoss,
      profitFactor,
      expectancy
    },
    byExitReason: groupSummary(closed, (t) => t.exitReason || 'unknown'),
    byEntryPhase: groupSummary(closed, (t) => t.entryPhase || 'unknown'),
    byEntryPriceBucket: groupSummary(closed, (t) => bucketEntryPrice(t)),
    bySideInferred: groupSummary(closed, (t) => {
      if (t.sideInferred === true) return 'inferred';
      if (t.sideInferred === false) return 'explicit';
      return 'unknown';
    })
  };
}

// API endpoints for UI to fetch data
app.get('/api/status', async (req, res) => {
  try {
    // Ensure ledger is initialized at least once so summary exists.
    await initializeLedger();

    const ledgerData = getLedger();
    const openTrade = getOpenTrade();
    const trader = getTraderInstance?.() ?? null;
    const entryDebug = trader?.lastEntryStatus ?? null;

    const summary = ledgerData.summary ?? recalculateSummary(ledgerData.trades ?? []);

    const starting = CONFIG.paperTrading.startingBalance ?? 1000;
    const realized = typeof summary.totalPnL === 'number' ? summary.totalPnL : 0;
    const balance = starting + realized;

    res.json({
      status: {
        ok: true,
        updatedAt: new Date().toISOString()
      },
      openTrade,
      entryDebug,
      ledgerSummary: summary,
      balance: { starting, realized, balance },
      paperTrading: {
        stakePct: CONFIG.paperTrading.stakePct,
        minTradeUsd: CONFIG.paperTrading.minTradeUsd,
        maxTradeUsd: CONFIG.paperTrading.maxTradeUsd,
        stopLossPct: CONFIG.paperTrading.stopLossPct,
        flipOnProbabilityFlip: CONFIG.paperTrading.flipOnProbabilityFlip
      },
      // Very simple live runtime snapshot (set by index.js)
      runtime: globalThis.__uiStatus ?? null
    });
  } catch (error) {
    console.error("Error fetching status:", error);
    res.status(500).json({ status: { ok: false }, error: "Failed to fetch status data." });
  }
});

app.get('/api/trades', async (req, res) => {
  try {
    await initializeLedger();
    const ledgerData = getLedger();
    res.json(Array.isArray(ledgerData.trades) ? ledgerData.trades : []);
  } catch (error) {
    console.error("Error fetching trades:", error);
    res.status(500).json({ error: "Failed to fetch trades data." });
  }
});

app.get('/api/analytics', async (req, res) => {
  try {
    await initializeLedger();
    const ledgerData = getLedger();
    const analytics = computeAnalytics(ledgerData.trades);
    res.json(analytics);
  } catch (error) {
    console.error("Error fetching analytics:", error);
    res.status(500).json({ error: "Failed to fetch analytics data." });
  }
});

// Basic route for the root to serve index.html
app.get('/', (req, res) => {
  // Serve an index.html from the ui directory
  // Ensure index.html exists in src/ui/
  res.sendFile(path.join(uiPath, 'index.html'));
});

export function startUIServer() {
  // Warm the ledger so the UI doesn't throw on first load.
  initializeLedger().catch((e) => console.error("UI server ledger init failed:", e));

  app.listen(port, () => {
    console.log(`UI server running on http://localhost:${port}`);
    console.log(`To access remotely, use ngrok: ngrok http ${port}`);
  });
}
