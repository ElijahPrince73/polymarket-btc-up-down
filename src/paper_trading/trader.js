import { CONFIG } from "../config.js";
import { loadLedger, addTrade, updateTrade, getOpenTrade as ledgerGetOpenTrade, getLedger, recalculateSummary } from "./ledger.js";

// Core trading logic - NO fixed TP/SL, dynamic exits only
export class Trader {
  constructor() {
    this.openTrade = null;
    this.lastFlipAtMs = 0;

    // Debug / UI: why we did or didn't enter on the last check
    this.lastEntryStatus = {
      at: null,
      eligible: false,
      blockers: []
    };
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

  getBalanceSnapshot() {
    const ledger = getLedger();
    const summary = ledger.summary ?? recalculateSummary(ledger.trades ?? []);
    const starting = CONFIG.paperTrading.startingBalance ?? 1000;
    const realized = typeof summary.totalPnL === "number" ? summary.totalPnL : 0;
    const balance = starting + realized;
    return { balance, starting, realized };
  }

  computeContractSizeUsd() {
    const { balance } = this.getBalanceSnapshot();
    if (!Number.isFinite(balance) || balance <= 0) return 0;

    const stakePct = CONFIG.paperTrading.stakePct;
    const useDynamic = typeof stakePct === "number" && Number.isFinite(stakePct) && stakePct > 0;

    const minUsd = CONFIG.paperTrading.minTradeUsd ?? 0;
    const maxUsd = CONFIG.paperTrading.maxTradeUsd ?? Number.POSITIVE_INFINITY;

    let size = useDynamic ? (balance * stakePct) : (CONFIG.paperTrading.contractSize ?? 100);
    size = Math.max(minUsd, Math.min(maxUsd, size));
    size = Math.min(size, balance);

    // round to cents
    size = Math.floor(size * 100) / 100;
    return size;
  }

  async processSignals(signals, klines1m) {
    if (!CONFIG.paperTrading.enabled) return;

    const candleCount = Array.isArray(klines1m) ? klines1m.length : 0;
    const minCandlesForEntry = CONFIG.paperTrading.minCandlesForEntry ?? 30;
    const indicatorsReady = candleCount >= minCandlesForEntry;

    // IMPORTANT: We paper-trade the Polymarket contract, not BTC spot.
    // BTC price/klines are only used for generating the signal.
    const action = signals.rec?.action || "NONE";
    let side = signals.rec?.side;
    let sideInferred = false;
    const timeLeftMin = signals.timeLeftMin;
    const marketSlug = signals.market?.slug || "unknown";

    // Rec gating: strict requires explicit ENTER; loose allows entry if thresholds hit.
    const recGating = String(CONFIG.paperTrading.recGating || "loose");
    const strictRec = recGating === "strict";

    // If we are not in a trade and strict gating is enabled, short-circuit unless Rec=ENTER.
    if (!this.openTrade && strictRec && action !== "ENTER") {
      this.lastEntryStatus = {
        at: new Date().toISOString(),
        eligible: false,
        blockers: [`Rec=${action} (strict)`]
      };
      return;
    }

    // Always populate entry debug, even if we can't trade this tick.
    // This helps the UI show why no trade happened.
    const entryBlockers = [];

    // In loose mode, if the engine doesn't provide a side, infer it from the model probabilities.
    // This keeps paper trading active even when rec.action is conservative.
    if (!side && !strictRec) {
      const upP = typeof signals.modelUp === "number" ? signals.modelUp : null;
      const downP = typeof signals.modelDown === "number" ? signals.modelDown : null;
      if (upP !== null && downP !== null) {
        side = upP >= downP ? "UP" : "DOWN";
        sideInferred = true;
        entryBlockers.push(`Inferred side=${side}`);
      }
    }

    const currentPolyPrice = side ? (signals.polyPrices?.[side] ?? null) : null; // dollars (0..1)

    if (!side) entryBlockers.push("Missing side");
    if (side && (currentPolyPrice === null || currentPolyPrice === undefined)) entryBlockers.push("Missing Polymarket price");

    if (!side || currentPolyPrice === null) {
      this.lastEntryStatus = {
        at: new Date().toISOString(),
        eligible: false,
        blockers: entryBlockers.length ? entryBlockers : [`Rec=${action}`]
      };
      return;
    }

    // Market quality filters
    const poly = signals.polyMarketSnapshot;
    const spreadUp = poly?.orderbook?.up?.spread;
    const spreadDown = poly?.orderbook?.down?.spread;

    const hasBadSpread = (spreadUp !== null && spreadUp > CONFIG.paperTrading.maxSpread) ||
                         (spreadDown !== null && spreadDown > CONFIG.paperTrading.maxSpread);

    const liquidityNum = signals.market?.liquidityNum ?? null;
    const minLiquidity = CONFIG.paperTrading.minLiquidity ?? 0;
    const hasLowLiquidity = (typeof liquidityNum === "number" && Number.isFinite(liquidityNum))
      ? (liquidityNum < minLiquidity)
      : false;

    const isLowLiquidity = hasBadSpread || hasLowLiquidity;

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
    const canEnter = indicatorsReady;

    // Require core indicators to be populated (prevents 50/50 / undefined warm states)
    const ind = signals.indicators ?? {};
    const hasRsi = typeof ind.rsiNow === "number" && Number.isFinite(ind.rsiNow);
    const hasVwap = typeof ind.vwapNow === "number" && Number.isFinite(ind.vwapNow);
    const hasVwapSlope = typeof ind.vwapSlope === "number" && Number.isFinite(ind.vwapSlope);
    const hasMacd = typeof ind.macd?.hist === "number" && Number.isFinite(ind.macd.hist);
    const hasHeiken = typeof ind.heikenColor === "string" && ind.heikenColor.length > 0 && typeof ind.heikenCount === "number" && Number.isFinite(ind.heikenCount);
    const indicatorsPopulated = hasRsi && hasVwap && hasVwapSlope && hasMacd && hasHeiken;

    // Build debug blockers for UI
    const blockers = [...entryBlockers];
    if (!canEnter) blockers.push(`Warmup: candles ${candleCount}/${minCandlesForEntry}`);
    if (!indicatorsPopulated) blockers.push("Indicators not ready");
    if (this.openTrade) blockers.push("Trade already open");
    if (strictRec && signals.rec?.action !== "ENTER") blockers.push(`Rec=${signals.rec?.action || "NONE"} (strict)`);
    if (!strictRec && signals.rec?.action !== "ENTER") blockers.push(`Rec=${signals.rec?.action || "NONE"} (loose)`);
    if (isTooLateToEnter) blockers.push(`Too late (<${CONFIG.paperTrading.noEntryFinalMinutes}m)`);
    if (isLowLiquidity) blockers.push("Low liquidity / high spread");
    if (isLowVolume) blockers.push("Low volume");

    // Price sanity blockers
    const minPoly = CONFIG.paperTrading.minPolyPrice ?? 0.002;
    const maxPoly = CONFIG.paperTrading.maxPolyPrice ?? 0.98;
    if (!(typeof currentPolyPrice === "number") || !Number.isFinite(currentPolyPrice) || currentPolyPrice < minPoly || currentPolyPrice > maxPoly) {
      blockers.push(`Poly price out of bounds (${(currentPolyPrice ?? NaN) * 100}¢)`);
    }

    // Threshold blockers
    if (signals.rec?.side) {
      const modelProb = side === "UP" ? signals.modelUp : signals.modelDown;
      const edge = signals.rec?.edge ?? 0;
      const phase = signals.rec?.phase;
      let minProbReq, edgeReq;
      if (phase === "EARLY") { minProbReq = CONFIG.paperTrading.minProbEarly; edgeReq = CONFIG.paperTrading.edgeEarly; }
      else if (phase === "MID") { minProbReq = CONFIG.paperTrading.minProbMid; edgeReq = CONFIG.paperTrading.edgeMid; }
      else { minProbReq = CONFIG.paperTrading.minProbLate; edgeReq = CONFIG.paperTrading.edgeLate; }

      if (typeof modelProb === "number" && Number.isFinite(modelProb) && modelProb < minProbReq) blockers.push(`Prob ${modelProb.toFixed(3)} < ${minProbReq}`);
      if ((edge || 0) < edgeReq) blockers.push(`Edge ${(edge || 0).toFixed(3)} < ${edgeReq}`);
    }

    this.lastEntryStatus = {
      at: new Date().toISOString(),
      eligible: blockers.length === 0,
      blockers
    };

    const recAction = signals.rec?.action || "NONE";
    const wantsEnter = (recAction === "ENTER") || !strictRec;

    // No-trade if volume is below threshold(s)
    if (canEnter && indicatorsPopulated && !this.openTrade && wantsEnter && !isTooLateToEnter && !isLowLiquidity && !isLowVolume) {
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

        const contractSizeUsd = this.computeContractSizeUsd();
        if (!contractSizeUsd || contractSizeUsd <= 0) {
          console.warn("Skipping entry: no available balance for trade size.");
          return;
        }

        const shares = (entryPrice > 0) ? (contractSizeUsd / entryPrice) : null;
        if (shares === null || !Number.isFinite(shares) || shares <= 0) return;

        this.openTrade = {
          id: Date.now().toString() + Math.random().toString(36).substring(2, 8),
          timestamp: new Date().toISOString(),
          marketSlug,
          side,
          instrument: "POLY",
          entryPrice, // dollars (0..1)
          shares,
          contractSize: contractSizeUsd,
          status: "OPEN",
          entryTime: new Date().toISOString(),
          exitPrice: null,
          exitTime: null,
          pnl: 0,
          entryPhase: phase,
          sideInferred
        };
        await addTrade(this.openTrade);
        const { balance } = this.getBalanceSnapshot();
        console.log(`📈 TRADE OPENED (POLY): ${side} @ ${(entryPrice * 100).toFixed(2)}¢ | $${contractSizeUsd} (balance ~$${balance.toFixed(2)})`);
      }
    }

    // --- EXIT ---
    else if (this.openTrade) {
      const trade = this.openTrade;
      let shouldExit = false;
      let exitReason = "";
      let shouldFlip = false;

      // If the Polymarket market rolled to a new slug, close the old trade so it can't get "stuck".
      // Note: we use the current market's contract price as a best-effort mark.
      if (trade.marketSlug && marketSlug && trade.marketSlug !== marketSlug) {
        const exitPrice = signals.polyPrices?.[trade.side] ?? null;
        if (exitPrice !== null) {
          await this.closeTrade(trade, exitPrice, "Market Rollover");
        }
        return;
      }

      // Current mark-to-market PnL (for stop loss)
      const curPx = signals.polyPrices?.[trade.side] ?? null;
      let stopLossHit = false;
      if (curPx !== null) {
        const sharesNow = (typeof trade.shares === "number" && Number.isFinite(trade.shares))
          ? trade.shares
          : (trade.entryPrice > 0 ? trade.contractSize / trade.entryPrice : 0);
        const valueNow = sharesNow * curPx;
        const pnlNow = valueNow - trade.contractSize;
        const stopLossPct = CONFIG.paperTrading.stopLossPct ?? 0.25;
        const stopLossAmount = -Math.abs(trade.contractSize * stopLossPct);
        stopLossHit = pnlNow <= stopLossAmount;
      }

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

      if (!shouldExit && opposingMoreLikely) {
        shouldExit = true;
        exitReason = "Probability Flip";

        const flipEnabled = CONFIG.paperTrading.flipOnProbabilityFlip ?? true;
        const cooldownMs = (CONFIG.paperTrading.flipCooldownSeconds ?? 60) * 1000;
        const now = Date.now();

        // only flip if we can still enter and not too late, and cooldown passed
        if (flipEnabled && canEnter && !isTooLateToEnter && (now - this.lastFlipAtMs >= cooldownMs)) {
          shouldFlip = true;
        }
      }

      // Conditional stop loss: only stop out when we are materially losing AND the model has flipped against us.
      // This avoids getting chopped out by noise when the signal still supports the position.
      if (!shouldExit && stopLossHit && opposingMoreLikely) {
        shouldExit = true;
        exitReason = "Stop Loss";
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

          // Optional flip: immediately open the other side
          if (shouldFlip) {
            const newSide = trade.side === "UP" ? "DOWN" : "UP";
            const entryPrice = signals.polyPrices?.[newSide] ?? null;

            const minPoly = CONFIG.paperTrading.minPolyPrice ?? 0.001;
            const maxPoly = CONFIG.paperTrading.maxPolyPrice ?? 0.999;
            if (typeof entryPrice === "number" && Number.isFinite(entryPrice) && entryPrice >= minPoly && entryPrice <= maxPoly && !isLowLiquidity && !isLowVolume) {
              const contractSizeUsd = this.computeContractSizeUsd();
              if (!contractSizeUsd || contractSizeUsd <= 0) {
                console.warn("Skipping flip entry: no available balance for trade size.");
              } else {
                const shares = entryPrice > 0 ? (contractSizeUsd / entryPrice) : null;
                if (shares !== null && Number.isFinite(shares) && shares > 0) {
                  const flipped = {
                    id: Date.now().toString() + Math.random().toString(36).substring(2, 8),
                    timestamp: new Date().toISOString(),
                    marketSlug,
                    side: newSide,
                    instrument: "POLY",
                    entryPrice,
                    shares,
                    contractSize: contractSizeUsd,
                    status: "OPEN",
                    entryTime: new Date().toISOString(),
                    exitPrice: null,
                    exitTime: null,
                    pnl: 0,
                    entryPhase: signals.rec?.phase ?? "MID",
                    entryReason: "Flip"
                  };

                  await addTrade(flipped);
                  this.openTrade = flipped;
                  this.lastFlipAtMs = Date.now();
                  const { balance } = this.getBalanceSnapshot();
                  console.log(`🔁 FLIP OPENED (POLY): ${newSide} @ ${(entryPrice * 100).toFixed(2)}¢ | $${contractSizeUsd} (balance ~$${balance.toFixed(2)})`);
                }
              }
            }
          }
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
