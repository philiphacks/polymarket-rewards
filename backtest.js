import fs from "fs";
import readline from "readline";

// ================= CONFIG TO TEST =================
const CONFIG = {
  // Core thresholds (NOW WITH TIME-BASED GRADUATION)
  Z_MIN_VERY_EARLY: 1.8,  // >5 mins (NEW!)
  Z_MIN_MID_EARLY: 1.4,   // 3-5 mins (NEW!)
  Z_MIN_LATE_2TO3: 1.0,   // 2-3 mins (NEW! - prevents SOL loss)
  Z_MIN_VERY_LATE: 0.8,   // <2 mins
  
  MIN_EDGE: 0.03,
  MAX_SHARES: 500,
  FEE_BPS: 10,
  
  // Feature toggles
  ENABLE_EARLY_TRADING: true,    // Toggle early trading (>5 mins)
  USE_DRIFT: true,               // Drift adjustment
  USE_KELLY_SIZING: true,       // Kelly vs fixed size
  KELLY_FRACTION: 0.15,
  STANDARD_TRADE_SIZE: 100,
  
  // NEW: Advanced risk controls
  USE_SIGNAL_DECAY_CHECK: true,      // Detect rapid z-score collapse
  SIGNAL_DECAY_THRESHOLD_EARLY: 0.4, // z drop in 30s (normal)
  SIGNAL_DECAY_THRESHOLD_LATE: 0.25, // z drop in 30s (late game)
  
  USE_WEAK_SIGNAL_COUNTER: true,     // Stop on persistent weak signals
  WEAK_SIGNAL_CONSECUTIVE_LIMIT: 3,  // Consecutive weak ticks
  WEAK_SIGNAL_RATIO_LIMIT: 6,        // 6 out of 10 ticks weak
  
  USE_EARLY_BASIS_RISK: true,        // Stop if price crosses strike early
  EARLY_BASIS_RISK_THRESHOLD_BPS: 20, // Price movement threshold
  
  USE_REGIME_SCALAR: true,           // Adjust thresholds by volatility
  REGIME_SCALAR_MIN: 0.7,
  REGIME_SCALAR_MAX: 1.4,
  
  // Risk controls
  USE_MAX_DRAWDOWN: false,
  MAX_DRAWDOWN_PCT: 0.30,
  
  MIN_EDGE_BY_ASSET: {
    BTC: 0.03,
    ETH: 0.03,
    SOL: 0.05,  // Require more edge for SOL
    XRP: 0.04
  },

  USE_FILL_PROB: false,
  FILL_PROB_LAYERS: [
    { maxProb: 0.60, fillFraction: 1.00 },
    { maxProb: 0.70, fillFraction: 0.90 },
    { maxProb: 0.80, fillFraction: 0.80 },
    { maxProb: 0.90, fillFraction: 0.60 },
    { maxProb: 0.95, fillFraction: 0.45 },
    { maxProb: 1.01, fillFraction: 0.30 }
  ]
};

// ===================================================

const LOG_FILES = [
  "files/ticks-20251120.jsonl",
  "files/ticks-20251121.jsonl",
  "files/ticks-20251122.jsonl",
  "files/ticks-20251123.jsonl",
  "files/ticks-20251124.jsonl",
];

const allTrades = [];
const blockedTrades = {
  zThreshold: [],
  signalDecay: [],
  weakSignalConsecutive: [],
  weakSignalRatio: [],
  earlyBasisRisk: []
};

// Normal CDF
function normCdf(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp(-0.5 * z * z);
  let p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  if (z > 0) p = 1 - p;
  return p;
}

// Estimate drift from price history (UPDATED - uses timestamps)
function estimateDrift(priceHistory) {
  if (!priceHistory || priceHistory.length < 10) return 0;
  
  const n = priceHistory.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  
  const baseTime = priceHistory[0].timestamp;
  
  for (let i = 0; i < n; i++) {
    const x = (priceHistory[i].timestamp - baseTime) / 60000; // Actual minutes
    const y = Math.log(priceHistory[i].price);
    sumX += x;
    sumY += y;
    sumXY += x * y;
    sumX2 += x * x;
  }
  
  const denominator = n * sumX2 - sumX * sumX;
  if (Math.abs(denominator) < 1e-10) return 0;
  
  const slope = (n * sumXY - sumX * sumY) / denominator;
  
  // Use current price, not oldest
  const currentPrice = priceHistory[priceHistory.length - 1].price;
  return slope * currentPrice;
}

// Kelly sizing (FIXED - binary options formula)
function kellySize(prob, price, maxShares, fraction = 0.15) {
  if (price >= 0.99 || price <= 0.01) return 0; // Changed from 10
  if (prob <= price) return 0; // no edge
  
  const kellyFraction = (prob - price) / (1 - price);
  const fractionalKelly = kellyFraction * fraction;
  const rawSize = fractionalKelly * maxShares;
  const roundedSize = Math.max(10, Math.floor(rawSize / 10) * 10);
  
  return Math.min(roundedSize, maxShares);
}

function getFillFraction(modelProb) {
  if (!CONFIG.USE_FILL_PROB) return 1.0;
  const layers = CONFIG.FILL_PROB_LAYERS || [];
  for (const layer of layers) {
    if (modelProb <= layer.maxProb) {
      return layer.fillFraction;
    }
  }
  return 1.0;
}

async function loadMarketsFromFiles(files) {
  const markets = {};

  for (const file of files) {
    if (!fs.existsSync(file)) {
      console.log(`⚠️  Skipping ${file} (not found)`);
      continue;
    }
    
    console.log(`⏳ Parsing logs from ${file}...`);

    const fileStream = fs.createReadStream(file);
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

    for await (const line of rl) {
      try {
        const tick = JSON.parse(line);

        if (!markets[tick.slug]) {
          markets[tick.slug] = {
            symbol: tick.symbol,
            ticks: [],
            finalPrice: 0,
            startPrice: tick.startPrice,
            positions: { UP: 0, DOWN: 0, CASH: 0 },
            trades: [],
            
            // NEW: State tracking for risk controls
            zHistory: [],
            weakSignalCount: 0,
            weakSignalHistory: []
          };
        }

        const m = markets[tick.slug];
        m.ticks.push(tick);
        m.finalPrice = tick.currentPrice;
        if (m.startPrice == null) m.startPrice = tick.startPrice;

      } catch (e) {
        // ignore corrupt lines
      }
    }
  }

  return markets;
}

async function runBacktest() {
  const markets = await loadMarketsFromFiles(LOG_FILES);
  console.log(
    `✅ Loaded ${Object.keys(markets).length} markets from ${LOG_FILES.length} files. Running simulation...\n`
  );

  let totalPnL = 0;
  let totalVolume = 0;
  let wins = 0;
  let losses = 0;
  let stopTrading = false;
  
  const marketResults = [];

  // --- SIMULATION LOOP ---
  for (const slug in markets) {
    if (CONFIG.USE_MAX_DRAWDOWN && stopTrading) break;
    
    const m = markets[slug];
    m.ticks.sort((a, b) => a.ts - b.ts);

    // Build price history for drift
    const priceHistory = m.ticks.map(t => ({ 
      price: t.currentPrice, 
      timestamp: t.ts 
    }));

    for (let i = 0; i < m.ticks.length; i++) {
      const tick = m.ticks[i];
      let { z, pUp, pDown, upAsk, downAsk, minsLeft, sigmaPerMin } = tick;

      // Get current positions
      const sharesUp = m.positions.UP || 0;
      const sharesDown = m.positions.DOWN || 0;

      // Asset-specific edge requirement
      const minEdge = CONFIG.MIN_EDGE_BY_ASSET[m.symbol] || CONFIG.MIN_EDGE;
      
      // Drift adjustment
      let adjustedZ = z;
      if (CONFIG.USE_DRIFT) {
        const drift = estimateDrift(priceHistory.slice(0, i + 1));
        const minsElapsed = 15 - minsLeft;
        const sigmaT = sigmaPerMin * Math.sqrt(minsLeft);
        
        if (sigmaT > 0) {
          adjustedZ = (tick.currentPrice - tick.startPrice - drift * minsElapsed) / sigmaT;
        }
      }
      
      const finalZ = adjustedZ;

      // Update z-history for signal decay detection
      m.zHistory.push({ z: finalZ, ts: tick.ts });
      // Keep last 30 seconds (5 ticks at 6s intervals)
      m.zHistory = m.zHistory.filter(h => tick.ts - h.ts < 30000);

      // Regime scalar calculation
      let regimeScalar = 1.0;
      if (CONFIG.USE_REGIME_SCALAR && tick.volRatio) {
        const rawScalar = Math.sqrt(tick.volRatio);
        regimeScalar = Math.max(CONFIG.REGIME_SCALAR_MIN, Math.min(CONFIG.REGIME_SCALAR_MAX, rawScalar));
      }

      // ========== NEW: TIME-BASED Z-THRESHOLD (GRADUATED) ==========
      let effectiveZMin;
      
      if (CONFIG.ENABLE_EARLY_TRADING) {
        if (minsLeft > 5) {
          effectiveZMin = CONFIG.Z_MIN_VERY_EARLY; // 1.8
        } else if (minsLeft > 3) {
          effectiveZMin = CONFIG.Z_MIN_MID_EARLY; // 1.4
        } else if (minsLeft > 2) {
          effectiveZMin = CONFIG.Z_MIN_LATE_2TO3 * regimeScalar; // 1.0 (NEW!)
        } else {
          effectiveZMin = CONFIG.Z_MIN_VERY_LATE * regimeScalar; // 0.8
        }
      } else {
        // Early trading disabled
        if (minsLeft > 5) {
          continue; // Skip
        } else if (minsLeft > 3) {
          effectiveZMin = 2.8 * regimeScalar; // Z_HUGE
        } else if (minsLeft > 2) {
          effectiveZMin = CONFIG.Z_MIN_LATE_2TO3 * regimeScalar; // 1.0 (NEW!)
        } else {
          effectiveZMin = CONFIG.Z_MIN_VERY_LATE * regimeScalar; // 0.8
        }
      }

      const absZ = Math.abs(finalZ);
      
      // Entry gating check
      if (absZ < effectiveZMin) {
        blockedTrades.zThreshold.push({
          symbol: m.symbol,
          slug: slug,
          ts: tick.ts,
          minsLeft: minsLeft,
          z: finalZ,
          required: effectiveZMin,
          upAsk: upAsk,
          downAsk: downAsk,
          pUp: pUp,
          pDown: pDown
        });
        continue;
      }

      // ========== NEW: SIGNAL DECAY CHECK ==========
      if (CONFIG.USE_SIGNAL_DECAY_CHECK && m.zHistory.length >= 5) {
        const recentZ = m.zHistory.slice(-5);
        const zChange = recentZ[0].z - recentZ[recentZ.length - 1].z;
        const decayThreshold = minsLeft < 3 
          ? CONFIG.SIGNAL_DECAY_THRESHOLD_LATE 
          : CONFIG.SIGNAL_DECAY_THRESHOLD_EARLY;

        // Check UP positions (z falling)
        if (sharesUp > 0 && zChange > decayThreshold) {
          blockedTrades.signalDecay.push({
            symbol: m.symbol,
            slug: slug,
            ts: tick.ts,
            minsLeft: minsLeft,
            side: 'UP',
            z: finalZ,
            zChange: zChange,
            threshold: decayThreshold,
            sharesUp: sharesUp
          });
          continue;
        }

        // Check DOWN positions (z rising)
        if (sharesDown > 0 && zChange < -decayThreshold) {
          blockedTrades.signalDecay.push({
            symbol: m.symbol,
            slug: slug,
            ts: tick.ts,
            minsLeft: minsLeft,
            side: 'DOWN',
            z: finalZ,
            zChange: Math.abs(zChange),
            threshold: decayThreshold,
            sharesDown: sharesDown
          });
          continue;
        }
      }

      // ========== NEW: WEAK SIGNAL COUNTER (METHOD 1 - CONSECUTIVE) ==========
      if (CONFIG.USE_WEAK_SIGNAL_COUNTER) {
        if (sharesUp > 0 && finalZ > 0 && finalZ < 0.8) {
          m.weakSignalCount++;
          
          if (m.weakSignalCount > CONFIG.WEAK_SIGNAL_CONSECUTIVE_LIMIT) {
            blockedTrades.weakSignalConsecutive.push({
              symbol: m.symbol,
              slug: slug,
              ts: tick.ts,
              minsLeft: minsLeft,
              side: 'UP',
              z: finalZ,
              count: m.weakSignalCount,
              sharesUp: sharesUp
            });
            continue;
          }
        } else if (sharesDown > 0 && finalZ < 0 && finalZ > -0.8) {
          m.weakSignalCount++;
          
          if (m.weakSignalCount > CONFIG.WEAK_SIGNAL_CONSECUTIVE_LIMIT) {
            blockedTrades.weakSignalConsecutive.push({
              symbol: m.symbol,
              slug: slug,
              ts: tick.ts,
              minsLeft: minsLeft,
              side: 'DOWN',
              z: finalZ,
              count: m.weakSignalCount,
              sharesDown: sharesDown
            });
            continue;
          }
        } else {
          m.weakSignalCount = 0;
        }

        // ========== NEW: METHOD 2 - RATIO-BASED ==========
        const isWeak = (sharesUp > 0 && finalZ > 0 && finalZ < 0.8) || 
                       (sharesDown > 0 && finalZ < 0 && finalZ > -0.8);
        
        m.weakSignalHistory.push(isWeak);
        if (m.weakSignalHistory.length > 10) {
          m.weakSignalHistory.shift();
        }

        const weakCount = m.weakSignalHistory.filter(x => x).length;
        if (weakCount >= CONFIG.WEAK_SIGNAL_RATIO_LIMIT) {
          blockedTrades.weakSignalRatio.push({
            symbol: m.symbol,
            slug: slug,
            ts: tick.ts,
            minsLeft: minsLeft,
            z: finalZ,
            weakCount: weakCount,
            totalTicks: m.weakSignalHistory.length,
            sharesUp: sharesUp,
            sharesDown: sharesDown
          });
          continue;
        }
      }

      // ========== NEW: EARLY BASIS RISK CHECK ==========
      if (CONFIG.USE_EARLY_BASIS_RISK && minsLeft > 5) {
        const distFromStrike = (tick.currentPrice - tick.startPrice) / tick.startPrice * 10000; // bps
        
        // If price crossed strike significantly against our position, stop
        if (distFromStrike < -CONFIG.EARLY_BASIS_RISK_THRESHOLD_BPS && sharesUp > 0) {
          blockedTrades.earlyBasisRisk.push({
            symbol: m.symbol,
            slug: slug,
            ts: tick.ts,
            minsLeft: minsLeft,
            side: 'UP',
            distFromStrike: distFromStrike,
            sharesUp: sharesUp
          });
          continue;
        }
        
        if (distFromStrike > CONFIG.EARLY_BASIS_RISK_THRESHOLD_BPS && sharesDown > 0) {
          blockedTrades.earlyBasisRisk.push({
            symbol: m.symbol,
            slug: slug,
            ts: tick.ts,
            minsLeft: minsLeft,
            side: 'DOWN',
            distFromStrike: distFromStrike,
            sharesDown: sharesDown
          });
          continue;
        }
      }

      // ========== TRADE LOGIC ==========
      const modelProbForTrade = finalZ > 0 ? pUp : pDown;
      const priceForTrade = finalZ > 0 ? upAsk : downAsk;

      let intendedSize = CONFIG.STANDARD_TRADE_SIZE;
      if (CONFIG.USE_KELLY_SIZING && upAsk && downAsk && priceForTrade) {
        intendedSize = kellySize(
          modelProbForTrade,
          priceForTrade,
          CONFIG.MAX_SHARES,
          CONFIG.KELLY_FRACTION
        );
      }
      
      const fillFraction = getFillFraction(modelProbForTrade);
      let filledSize = Math.floor(intendedSize * fillFraction / 10) * 10;
      if (filledSize < 10) filledSize = 0;

      // --- UP LOGIC ---
      if (upAsk && finalZ >= effectiveZMin) {
        const ev = pUp - upAsk;
        if (ev > minEdge && filledSize > 0) {
          const vol = executeTrade(m, "UP", upAsk, filledSize, tick.ts);
          totalVolume += vol;

          allTrades.push({
            symbol: m.symbol,
            side: "UP",
            entryPrice: upAsk,
            modelProb: pUp,
            minsLeft: minsLeft,
            size: filledSize,
            intendedSize: intendedSize,
            fillFraction: fillFraction,
            marketSlug: slug,
            timestamp: tick.ts,
            z: finalZ,
            ev: ev,
            effectiveZMin: effectiveZMin,
            regimeScalar: regimeScalar
          });
        }
      }

      // --- DOWN LOGIC ---
      if (downAsk && finalZ <= -effectiveZMin) {
        const ev = pDown - downAsk;
        if (ev > minEdge && filledSize > 0) {
          const vol = executeTrade(m, "DOWN", downAsk, filledSize, tick.ts);
          totalVolume += vol;

          allTrades.push({
            symbol: m.symbol,
            side: "DOWN",
            entryPrice: downAsk,
            modelProb: pDown,
            minsLeft: minsLeft,
            size: filledSize,
            intendedSize: intendedSize,
            fillFraction: fillFraction,
            marketSlug: slug,
            timestamp: tick.ts,
            z: finalZ,
            ev: ev,
            effectiveZMin: effectiveZMin,
            regimeScalar: regimeScalar
          });
        }
      }
    }

    // --- SETTLEMENT ---
    const winner = m.finalPrice > m.startPrice ? "UP" : "DOWN";
    const payout = (m.positions[winner] || 0) * 1.0;
    const netProfit = m.positions.CASH + payout;

    if (m.positions.UP > 0 || m.positions.DOWN > 0) {
      totalPnL += netProfit;
      
      const settlementTime = m.ticks[m.ticks.length - 1]?.ts || Date.now();
      marketResults.push({
        timestamp: settlementTime,
        pnl: netProfit,
        symbol: m.symbol,
        slug: slug
      });
      
      if (netProfit > 0) wins++; else if (netProfit < 0) losses++;
      
      if (Math.abs(netProfit) > 0.5) {
        console.log(
          `[${m.symbol}] ${winner} | $${m.startPrice.toFixed(2)}→$${m.finalPrice.toFixed(2)} | ` +
          `+${m.positions.UP}UP +${m.positions.DOWN}DN | PnL: $${netProfit.toFixed(2)}`
        );
      }
    }
  }

  // --- CALCULATE DRAWDOWN ---
  marketResults.sort((a, b) => a.timestamp - b.timestamp);
  
  let runningPnL = 0;
  let peak = 0;
  let maxDrawdown = 0;
  let everWentPositive = false;
  
  for (const result of marketResults) {
    runningPnL += result.pnl;
    
    if (runningPnL > 0) {
      everWentPositive = true;
      if (runningPnL > peak) {
        peak = runningPnL;
      }
    }
    
    if (everWentPositive && peak > 0) {
      const drawdown = (peak - runningPnL) / peak;
      if (drawdown > maxDrawdown && drawdown >= 0) {
        maxDrawdown = drawdown;
      }
    }
  }
  
  if (!everWentPositive) {
    maxDrawdown = 0;
  }

  // --- ANALYSIS ---
  runDeepAnalysis(allTrades, markets);
  runAdvancedMetrics(allTrades, totalPnL, totalVolume);
  runBlockedTradesAnalysis(blockedTrades);

  console.log("\n================ RESULTS ================");
  console.log(`Config: Early=${CONFIG.Z_MIN_VERY_EARLY}, Mid=${CONFIG.Z_MIN_MID_EARLY}, Late2-3=${CONFIG.Z_MIN_LATE_2TO3}, VeryLate=${CONFIG.Z_MIN_VERY_LATE}`);
  console.log(`Features: Drift=${CONFIG.USE_DRIFT}, Kelly=${CONFIG.USE_KELLY_SIZING}, Early Trading=${CONFIG.ENABLE_EARLY_TRADING}`);
  console.log(`Risk Controls: SignalDecay=${CONFIG.USE_SIGNAL_DECAY_CHECK}, WeakSignal=${CONFIG.USE_WEAK_SIGNAL_COUNTER}, EarlyBasis=${CONFIG.USE_EARLY_BASIS_RISK}`);
  console.log(`Markets Traded: ${wins + losses}`);
  console.log(`Win Rate: ${((wins / (wins + losses || 1)) * 100).toFixed(1)}%`);
  console.log(`Total Volume: ${totalVolume.toFixed(2)}`);
  console.log(`Max Drawdown: ${(maxDrawdown * 100).toFixed(1)}%`);
  console.log(`TOTAL PnL: ${totalPnL.toFixed(2)}`);
  console.log(`Return on Volume: ${((totalPnL / totalVolume) * 100).toFixed(2)}%`);
  console.log("=========================================");
}

function runBlockedTradesAnalysis(blocked) {
  console.log("\n\n🛡️ ============ BLOCKED TRADES ANALYSIS ============");
  
  const totalBlocked = Object.values(blocked).reduce((sum, arr) => sum + arr.length, 0);
  console.log(`Total Blocked: ${totalBlocked} trades\n`);
  
  // Z-Threshold blocks
  if (blocked.zThreshold.length > 0) {
    console.log(`--- [1] Z-THRESHOLD BLOCKS: ${blocked.zThreshold.length} ---`);
    
    const byTime = {
      'VeryEarly (>5m)': [],
      'MidEarly (3-5m)': [],
      'Late2-3 (2-3m)': [],
      'VeryLate (<2m)': []
    };
    
    blocked.zThreshold.forEach(b => {
      let key = 'VeryLate (<2m)';
      if (b.minsLeft > 5) key = 'VeryEarly (>5m)';
      else if (b.minsLeft > 3) key = 'MidEarly (3-5m)';
      else if (b.minsLeft > 2) key = 'Late2-3 (2-3m)';
      byTime[key].push(b);
    });
    
    Object.entries(byTime).forEach(([period, blocks]) => {
      if (blocks.length > 0) {
        const avgZ = blocks.reduce((sum, b) => sum + Math.abs(b.z), 0) / blocks.length;
        const avgReq = blocks.reduce((sum, b) => sum + b.required, 0) / blocks.length;
        console.log(`  ${period}: ${blocks.length} blocks (avg |z|=${avgZ.toFixed(2)}, req=${avgReq.toFixed(2)})`);
      }
    });
  }
  
  // Signal decay blocks
  if (blocked.signalDecay.length > 0) {
    console.log(`\n--- [2] SIGNAL DECAY BLOCKS: ${blocked.signalDecay.length} ---`);
    
    const byAsset = {};
    blocked.signalDecay.forEach(b => {
      if (!byAsset[b.symbol]) byAsset[b.symbol] = [];
      byAsset[b.symbol].push(b);
    });
    
    Object.entries(byAsset).forEach(([sym, blocks]) => {
      const avgDecay = blocks.reduce((sum, b) => sum + b.zChange, 0) / blocks.length;
      console.log(`  ${sym}: ${blocks.length} blocks (avg z-drop=${avgDecay.toFixed(2)})`);
    });
    
    // Show top 3 largest decays
    console.log(`\n  Top 3 Largest Decays:`);
    blocked.signalDecay
      .sort((a, b) => b.zChange - a.zChange)
      .slice(0, 3)
      .forEach((b, i) => {
        console.log(`    ${i+1}. ${b.symbol} ${b.side} z-drop=${b.zChange.toFixed(2)} (${b.minsLeft.toFixed(1)}min left, ${b.sharesUp || b.sharesDown} shares)`);
      });
  }
  
  // Weak signal consecutive blocks
  if (blocked.weakSignalConsecutive.length > 0) {
    console.log(`\n--- [3] WEAK SIGNAL CONSECUTIVE BLOCKS: ${blocked.weakSignalConsecutive.length} ---`);
    
    const byAsset = {};
    blocked.weakSignalConsecutive.forEach(b => {
      if (!byAsset[b.symbol]) byAsset[b.symbol] = [];
      byAsset[b.symbol].push(b);
    });
    
    Object.entries(byAsset).forEach(([sym, blocks]) => {
      console.log(`  ${sym}: ${blocks.length} blocks`);
    });
  }
  
  // Weak signal ratio blocks
  if (blocked.weakSignalRatio.length > 0) {
    console.log(`\n--- [4] WEAK SIGNAL RATIO BLOCKS: ${blocked.weakSignalRatio.length} ---`);
    
    const byAsset = {};
    blocked.weakSignalRatio.forEach(b => {
      if (!byAsset[b.symbol]) byAsset[b.symbol] = [];
      byAsset[b.symbol].push(b);
    });
    
    Object.entries(byAsset).forEach(([sym, blocks]) => {
      const avgWeak = blocks.reduce((sum, b) => sum + b.weakCount, 0) / blocks.length;
      console.log(`  ${sym}: ${blocks.length} blocks (avg ${avgWeak.toFixed(1)}/10 weak)`);
    });
  }
  
  // Early basis risk blocks
  if (blocked.earlyBasisRisk.length > 0) {
    console.log(`\n--- [5] EARLY BASIS RISK BLOCKS: ${blocked.earlyBasisRisk.length} ---`);
    
    const byAsset = {};
    blocked.earlyBasisRisk.forEach(b => {
      if (!byAsset[b.symbol]) byAsset[b.symbol] = [];
      byAsset[b.symbol].push(b);
    });
    
    Object.entries(byAsset).forEach(([sym, blocks]) => {
      const avgDist = blocks.reduce((sum, b) => sum + Math.abs(b.distFromStrike), 0) / blocks.length;
      console.log(`  ${sym}: ${blocks.length} blocks (avg ${avgDist.toFixed(1)}bps from strike)`);
    });
  }
  
  console.log("\n====================================================\n");
}

function runDeepAnalysis(trades, marketsMap) {
  console.log("\n\n📊 ============ DEEP DIVE ANALYSIS ============");

  const calculateTradePnL = (trade) => {
    const m = marketsMap[trade.marketSlug];
    const winner = m.finalPrice > m.startPrice ? "UP" : "DOWN";
    const won = trade.side === winner;
    const cost = trade.size * trade.entryPrice;
    const fee = cost * (CONFIG.FEE_BPS / 10000);
    const totalCost = cost + fee;
    const payout = won ? trade.size : 0;
    return payout - totalCost;
  };

  // A. CALIBRATION CHECK
  console.log("\n--- [A] CALIBRATION CHECK ---");
  const buckets = {};
  
  trades.forEach(t => {
    const pnl = calculateTradePnL(t);
    const won = pnl > 0;
    const bucket = (Math.floor(t.modelProb * 20) / 20).toFixed(2);
    
    if (!buckets[bucket]) buckets[bucket] = { total: 0, wins: 0, pnl: 0 };
    buckets[bucket].total++;
    if (won) buckets[bucket].wins++;
    buckets[bucket].pnl += pnl;
  });

  console.log("Prob Range  | Trades | Actual Win% | Expected | Diff   | Avg PnL");
  Object.keys(buckets).sort().forEach(b => {
    const d = buckets[b];
    const actualWinRate = (d.wins / d.total);
    const predicted = parseFloat(b);
    const diff = actualWinRate - predicted;
    const alert = Math.abs(diff) > 0.10 ? "⚠️" : "✅";
    
    console.log(
      `${b}-${(parseFloat(b)+0.05).toFixed(2)} | ` +
      `${d.total.toString().padEnd(6)} | ` +
      `${(actualWinRate * 100).toFixed(1)}%      | ` +
      `${(predicted * 100).toFixed(1)}%    | ` +
      `${(diff * 100).toFixed(1)}% ${alert} | ` +
      `$${(d.pnl / d.total).toFixed(3)}`
    );
  });

  // B. TIME ANALYSIS
  console.log("\n--- [B] TIME ANALYSIS (Entry Timing) ---");
  const timeStats = {
    "VeryEarly (>5m)": { pnl: 0, count: 0 },
    "MidEarly (3-5m)": { pnl: 0, count: 0 },
    "Late2-3  (2-3m)": { pnl: 0, count: 0 },
    "VeryLate (<2m)": { pnl: 0, count: 0 },
  };

  trades.forEach(t => {
    const pnl = calculateTradePnL(t);
    let key = "VeryLate (<2m)";
    if (t.minsLeft > 5) key = "VeryEarly (>5m)";
    else if (t.minsLeft > 3) key = "MidEarly (3-5m)";
    else if (t.minsLeft > 2) key = "Late2-3  (2-3m)";
    
    timeStats[key].pnl += pnl;
    timeStats[key].count++;
  });

  for (const [key, stat] of Object.entries(timeStats)) {
    const avgPnL = stat.count > 0 ? stat.pnl / stat.count : 0;
    const winRate = stat.count > 0 ? (stat.pnl > 0 ? 100 : 0) : 0;
    console.log(
      `${key} : PnL $${stat.pnl.toFixed(2)} (${stat.count} trades, ` +
      `Avg: $${avgPnL.toFixed(3)})`
    );
  }

  // C. ASSET PERFORMANCE
  console.log("\n--- [C] ASSET PERFORMANCE ---");
  const assetStats = {};

  trades.forEach(t => {
    const pnl = calculateTradePnL(t);
    if (!assetStats[t.symbol]) {
      assetStats[t.symbol] = { pnl: 0, vol: 0, trades: 0, wins: 0 };
    }
    
    assetStats[t.symbol].pnl += pnl;
    assetStats[t.symbol].trades++;
    assetStats[t.symbol].vol += (t.size * t.entryPrice);
    if (pnl > 0) assetStats[t.symbol].wins++;
  });

  console.log("Symbol | PnL      | Trades | Win%   | Volume   | RoV");
  Object.keys(assetStats).sort().forEach(sym => {
    const s = assetStats[sym];
    const winRate = (s.wins / s.trades) * 100;
    const rov = (s.pnl / s.vol) * 100;
    console.log(
      `${sym.padEnd(6)} | ` +
      `$${s.pnl.toFixed(2).padStart(7)} | ` +
      `${s.trades.toString().padStart(6)} | ` +
      `${winRate.toFixed(1).padStart(5)}% | ` +
      `$${s.vol.toFixed(0).padStart(7)} | ` +
      `${rov.toFixed(2)}%`
    );
  });

  // D. Z-SCORE ANALYSIS
  console.log("\n--- [D] Z-SCORE EFFECTIVENESS ---");
  const zBuckets = {};
  
  trades.forEach(t => {
    const pnl = calculateTradePnL(t);
    const absZ = Math.abs(t.z);
    let bucket = "0.8-1.0";
    if (absZ >= 1.0 && absZ < 1.5) bucket = "1.0-1.5";
    if (absZ >= 1.5 && absZ < 2.0) bucket = "1.5-2.0";
    if (absZ >= 2.0 && absZ < 3.0) bucket = "2.0-3.0";
    if (absZ >= 3.0) bucket = "3.0+";
    
    if (!zBuckets[bucket]) zBuckets[bucket] = { pnl: 0, count: 0, wins: 0 };
    zBuckets[bucket].pnl += pnl;
    zBuckets[bucket].count++;
    if (pnl > 0) zBuckets[bucket].wins++;
  });

  console.log("Z Range | Trades | Win%   | Avg PnL");
  ["0.8-1.0", "1.0-1.5", "1.5-2.0", "2.0-3.0", "3.0+"].forEach(key => {
    const d = zBuckets[key];
    if (!d || d.count === 0) return;
    const winRate = (d.wins / d.count) * 100;
    const avgPnL = d.pnl / d.count;
    console.log(
      `${key.padEnd(7)} | ${d.count.toString().padStart(6)} | ` +
      `${winRate.toFixed(1).padStart(5)}% | $${avgPnL.toFixed(4)}`
    );
  });
  
  console.log("============================================\n");
}

function runAdvancedMetrics(trades, totalPnL, totalVolume) {
  console.log("\n--- [E] ADVANCED METRICS ---");
  
  // Sharpe Ratio
  const dailyReturns = [];
  let currentDay = null;
  let dayPnL = 0;
  
  trades.forEach(t => {
    const day = new Date(t.timestamp).toDateString();
    if (currentDay !== day) {
      if (currentDay !== null) dailyReturns.push(dayPnL);
      currentDay = day;
      dayPnL = 0;
    }
    dayPnL += t.ev * t.size;
  });
  if (dayPnL !== 0) dailyReturns.push(dayPnL);
  
  if (dailyReturns.length > 1) {
    const avgReturn = dailyReturns.reduce((a,b) => a+b, 0) / dailyReturns.length;
    const variance = dailyReturns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / dailyReturns.length;
    const stdDev = Math.sqrt(variance);
    const sharpe = stdDev > 0 ? avgReturn / stdDev : 0;
    
    console.log(`Daily Sharpe Ratio: ${sharpe.toFixed(2)}`);
    console.log(`Avg Daily PnL: $${avgReturn.toFixed(2)} ± $${stdDev.toFixed(2)}`);
  }
  
  // Profit Factor
  let grossWins = 0, grossLosses = 0;
  trades.forEach(t => {
    const estimatedPnL = t.ev * t.size;
    if (estimatedPnL > 0) grossWins += estimatedPnL;
    else grossLosses += Math.abs(estimatedPnL);
  });
  
  const profitFactor = grossLosses > 0 ? grossWins / grossLosses : 0;
  console.log(`Profit Factor: ${profitFactor.toFixed(2)}`);
  
  console.log(`Total Trades: ${trades.length}`);
  console.log(`Avg Entry Time: ${(trades.reduce((sum, t) => sum + (15 - t.minsLeft), 0) / trades.length).toFixed(1)} mins into market`);
}

function executeTrade(market, side, price, size, timestamp) {
  const currentSize = market.positions[side] || 0;
  if (currentSize + size > CONFIG.MAX_SHARES) return 0;

  market.positions[side] += size;
  const rawCost = size * price;
  const fee = rawCost * (CONFIG.FEE_BPS / 10000);
  const totalCost = rawCost + fee;
  market.positions.CASH -= totalCost;
  
  market.trades.push({
    side,
    price,
    size,
    timestamp,
    cost: totalCost
  });
  
  return rawCost;
}

runBacktest();
