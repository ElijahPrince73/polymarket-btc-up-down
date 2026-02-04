import { CONFIG } from "../config.js";
import { loadLedger, addTrade, updateTrade, getOpenTrade as ledgerGetOpenTrade, getLedger, recalculateSummary, updateLedger } from "./ledger.js";

// Core trading logic - NO fixed TP/SL, dynamic exits only
export class Trader {
  constructor() {
    this.openTrade = null;
  }

  async initialize() {
    loadLedger();
    this.openTrade = ledgerGetOpenTrade();

    // Guard against corrupted/invalid open trades (e.g., entryPrice 0.00)
    if (this.openTrade) {
      const t = this.openTrade;
      const badPrice = typeof t.entryPrice !== "number" || !Number.isFinite(t.entryPrice) || t.entryPrice <= 0;
      const badShares = t.shares !== null && t.shares !== undefined && (!Number.isFinite(Number(t.shares)) || Number(t.shares) <= 0);
      if (badPrice || badShares) {
        console.warn("Invalid open trade found in ledger; force-closing:", { id: t.id, entryPrice: t.entryPrice, shares: t.shares });
        const forced = {
          ...t,
          status: "CLOSED",
          exitPrice: t.exitPrice ?? null,
          exitTime: new Date().toISOString(),
          pnl: 0,
          exitReason: "Invalid Entry (sanity check)"
        };
        await updateTrade(t.id, forced);
        this.openTrade = null;
      }
    }

    console.log("Trader initialized. Open trade:", this.openTrade ? this.openTrade.id.substring(0, 8) : "None");
  }

  async processSignals(signals, klines1m) {
    if (!CONFIG.paperTrading.enabled) return;

    const candleCount = Array.isArray(klines1m) ? klines1m.length : 0;
    const minCandlesForEntry = CONFIG.paperTrading.minCandlesForEntry ?? 30;
    const indicatorsReady = candleCount >= minCandlesForEntry;

    // IMPORTANT: We paper-trade the Polymarket contract, not BTC spot.
    // BTC price/klines are only used for generating the signal.
    const side = signals.rec?.side;
    const currentPolyPrice = side ? (signals.polyPrices?.[side] ?? null) : null; // dollars (0..1)
    const timeLeftMin = signals.timeLeftMin;
    const marketSlug = signals.market?.slug || "unknown";

    if (!side || currentPolyPrice === null) return;

    // Market quality filters
    const poly = signals.polyMarketSnapshot;
    const spreadUp = poly?.orderbook?.up?.spread;
    const spreadDown = poly?.orderbook?.down?.spread;
    const isLowLiquidity = (spreadUp !== null && spreadUp > CONFIG.paperTrading.maxSpread) ||
                           (spreadDown !== null && spreadDown > CONFIG.paperTrading.maxSpread);

    const isTooLateToEnter = timeLeftMin < CONFIG.paperTrading.noEntryFinalMinutes;

    // Volume filter
    const volumeRecent = signals.indicators?.volumeRecent ?? null;
    const volumeAvg = signals.indicators?.volumeAvg ?? null;
    const minVolumeRecent = CONFIG.paperTrading.minVolumeRecent ?? 0;
    const minVolumeRatio = CONFIG.paperTrading.minVolumeRatio ?? 0;

    const isLowVolumeAbsolute = (minVolumeRecent > 0) && (volumeRecent !== null) && (volumeRecent < minVolumeRecent);
    const isLowVolumeRelative = (minVolumeRatio > 0) && (volumeRecent !== null) && (volumeAvg !== null) && (volumeRecent < (volumeAvg * minVolumeRatio));
    const isLowVolume = isLowVolumeAbsolute || isLowVolumeRelative;

    // --- ENTRY ---
    // Wait until indicators are warmed up (enough candles)
    if (!indicatorsReady) {
      // Still allow exits below.
      return;
    }

    // No-trade if volume is below threshold(s)
    if (!this.openTrade && signals.rec.action === "ENTER" && !isTooLateToEnter && !isLowLiquidity && !isLowVolume) {
      const { phase, edge } = signals.rec;
      
      // Phase-based thresholds
      let minProb, edgeThreshold;
      if (phase === "EARLY") {
        minProb = CONFIG.paperTrading.minProbEarly;
        edgeThreshold = CONFIG.paperTrading.edgeEarly;
      } else if (phase === "MID") {
        minProb = CONFIG.paperTrading.minProbMid;
        edgeThreshold = CONFIG.paperTrading.edgeMid;
      } else {
        minProb = CONFIG.paperTrading.minProbLate;
        edgeThreshold = CONFIG.paperTrading.edgeLate;
      }

      const modelProb = side === "UP" ? signals.modelUp : signals.modelDown;
      const meetsThresholds = modelProb >= minProb && (edge || 0) >= edgeThreshold;

      if (meetsThresholds) {
        // Model: spend $contractSize at entry price; shares = notional / price
        const entryPrice = currentPolyPrice;

        // Sanity guard: never enter at 0 / near-0 prices.
        const minPoly = CONFIG.paperTrading.minPolyPrice ?? 0.001;
        const maxPoly = CONFIG.paperTrading.maxPolyPrice ?? 0.999;
        if (!(typeof entryPrice === "number") || !Number.isFinite(entryPrice) || entryPrice < minPoly || entryPrice > maxPoly) {
          // Skip entry if price is out of bounds
          console.warn(`Skipping entry due to invalid Poly price: side=${side} entryPrice=${entryPrice} min=${minPoly} max=${maxPoly}`);
          return;
        }

        const shares = (entryPrice > 0) ? (CONFIG.paperTrading.contractSize / entryPrice) : null;
        if (shares === null || !Number.isFinite(shares) || shares <= 0) return;

        this.openTrade = {
          id: Date.now().toString() + Math.random().toString(36).substring(2, 8),
          timestamp: new Date().toISOString(),
          marketSlug,
          side,
          instrument: "POLY",
          entryPrice, // dollars (0..1)
          shares,
          contractSize: CONFIG.paperTrading.contractSize,
          status: "OPEN",
          entryTime: new Date().toISOString(),
          exitPrice: null,
          exitTime: null,
          pnl: 0,
          entryPhase: phase
        };
        await addTrade(this.openTrade);
        console.log(`📈 TRADE OPENED (POLY): ${side} @ ${(entryPrice * 100).toFixed(2)}¢ | $${CONFIG.paperTrading.contractSize}`);
      }
    }

    // --- EXIT ---
    else if (this.openTrade) {
      const trade = this.openTrade;
      let shouldExit = false;
      let exitReason = "";

      // Exit when the other side becomes more likely to complete.
      const upP = typeof signals.modelUp === "number" ? signals.modelUp : null;
      const downP = typeof signals.modelDown === "number" ? signals.modelDown : null;
      const minProb = CONFIG.paperTrading.exitFlipMinProb ?? 0.55;
      const margin = CONFIG.paperTrading.exitFlipMargin ?? 0.03;

      let opposingMoreLikely = false;
      if (trade.side === "UP" && upP !== null && downP !== null) {
        opposingMoreLikely = (downP >= minProb) && (downP >= upP + margin);
      }
      if (trade.side === "DOWN" && upP !== null && downP !== null) {
        opposingMoreLikely = (upP >= minProb) && (upP >= downP + margin);
      }

      if (opposingMoreLikely) {
        shouldExit = true;
        exitReason = "Probability Flip";
      }

      // Exit at end of candle
      if (!shouldExit && timeLeftMin < 0.5) {
        shouldExit = true;
        exitReason = "End of Candle";
      }

      if (shouldExit) {
        const exitPrice = signals.polyPrices?.[trade.side] ?? null;
        if (exitPrice !== null) {
          await this.closeTrade(trade, exitPrice, exitReason);
        }
      }
    }
  }

  async closeTrade(trade, exitPrice, reason) {
    // POLY behavior: $notional -> shares
    const shares = (typeof trade.shares === "number" && Number.isFinite(trade.shares))
      ? trade.shares
      : (trade.entryPrice > 0 ? trade.contractSize / trade.entryPrice : 0);

    const value = shares * exitPrice;
    const pnl = value - trade.contractSize;

    trade.exitPrice = exitPrice;
    trade.exitTime = new Date().toISOString();
    trade.pnl = Number(pnl.toFixed(2));
    trade.status = "CLOSED";
    trade.exitReason = reason;

    await updateTrade(trade.id, trade);
    
    const icon = pnl >= 0 ? "✅" : "❌";
    console.log(`${icon} TRADE CLOSED (POLY): ${trade.side} | Entry: ${(trade.entryPrice * 100).toFixed(2)}¢ → Exit: ${(exitPrice * 100).toFixed(2)}¢ | PnL: $${pnl.toFixed(2)} | ${reason}`);
    
    this.openTrade = null;
  }
}

// Singleton for UI access
let traderInstance = null;

export async function initializeTrader() {
  if (!traderInstance) {
    traderInstance = new Trader();
    await traderInstance.initialize();
  }
  return traderInstance;
}

export function getTraderInstance() {
  return traderInstance;
}

export function setTraderInstance(trader) {
  traderInstance = trader;
}

export function getOpenTrade() {
  return traderInstance?.openTrade || ledgerGetOpenTrade();
}
