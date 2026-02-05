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
