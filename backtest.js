import fs from "fs";
import readline from "readline";

// ================= CONFIG TO TEST =================
const CONFIG = {
  Z_MIN_EARLY: 1.0,
  Z_MIN_LATE: 0.7,
  MIN_EDGE: 0.03,
  MAX_SHARES: 500,
  FEE_BPS: 10,
  
  // NEW: Advanced features
  USE_DRIFT: true,           // Toggle drift adjustment
  REGIME_INVERSION: false,    // Toggle inverted regime logic
  KELLY_SIZING: true,        // Use Kelly vs fixed size
  KELLY_FRACTION: 0.15,       // Kelly fraction (0.25 = quarter Kelly, 0.15 = more conservative)
  USE_CORRELATION_CHECK: true, // Toggle correlation risk check
  
  // Risk controls
  USE_MAX_DRAWDOWN: false,    // Toggle drawdown stop
  MAX_DRAWDOWN_PCT: 0.30,     // Stop if down 30% (only if USE_MAX_DRAWDOWN = true)
  
  MIN_EDGE_BY_ASSET: {
    BTC: 0.03,
    ETH: 0.03,
    SOL: 0.05,  // Require more edge for SOL
    XRP: 0.04
  },

  USE_FILL_PROB: true,
  FILL_PROB_LAYERS: [
    { maxProb: 0.60, fillFraction: 1.00 }, // very likely to get filled
    { maxProb: 0.70, fillFraction: 0.90 },
    { maxProb: 0.80, fillFraction: 0.80 },
    { maxProb: 0.90, fillFraction: 0.60 },
    { maxProb: 0.95, fillFraction: 0.45 },
    { maxProb: 1.01, fillFraction: 0.30 } // > 0.95 → ~30% fills
  ]
};

// ===================================================

const LOG_FILE = "ticks-20251122.jsonl";
const LOG_FILES = [
  "ticks-20251120.jsonl",
  "ticks-20251121.jsonl",
  "ticks-20251122.jsonl",
  "ticks-20251123.jsonl"
];
const allTrades = [];

// Student's t-CDF (df=5)
function studentTCdf(t, df = 5) {
  if (df <= 0) return t > 0 ? 1 : 0;
  const x = df / (t * t + df);
  const a = df / 2;
  const b = 0.5;
  
  let beta;
  if (x < 0 || x > 1) return t > 0 ? 1 : 0;
  
  const terms = 20;
  let sum = 0;
  for (let i = 0; i < terms; i++) {
    const coef = Math.exp(
      a * Math.log(x) + 
      b * Math.log(1 - x) + 
      i * Math.log(1 - x) - 
      Math.log(b + i)
    );
    sum += coef;
  }
  beta = sum;
  
  const result = 0.5 + 0.5 * (t > 0 ? 1 : -1) * (1 - beta);
  return Math.max(0, Math.min(1, result));
}

// Normal CDF
function normCdf(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp(-0.5 * z * z);
  let p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  if (z > 0) p = 1 - p;
  return p;
}

// Estimate drift from price history
function estimateDrift(priceHistory) {
  if (!priceHistory || priceHistory.length < 10) return 0;
  
  const n = priceHistory.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  
  for (let i = 0; i < n; i++) {
    const x = i;
    const y = Math.log(priceHistory[i].price);
    sumX += x;
    sumY += y;
    sumXY += x * y;
    sumX2 += x * x;
  }
  
  const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
  return slope * priceHistory[0].price;
}

// Kelly sizing
function kellySize(prob, price, maxShares, fraction = 0.25) {
  if (price >= 1 || price <= 0) return 10; // fallback
  const odds = 1 / price - 1;
  const kelly = (prob * odds - (1 - prob)) / odds;
  const size = Math.max(0, kelly * fraction * maxShares);
  return Math.min(Math.max(10, Math.floor(size / 10) * 10), maxShares);
}

function getFillFraction(modelProb) {
  if (!CONFIG.USE_FILL_PROB) return 1.0;
  const layers = CONFIG.FILL_PROB_LAYERS || [];
  for (const layer of layers) {
    if (modelProb <= layer.maxProb) {
      return layer.fillFraction;
    }
  }
  return 1.0; // fallback
}

async function loadMarketsFromFiles(files) {
  const markets = {};

  for (const file of files) {
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
            trades: []
          };
        }

        const m = markets[tick.slug];
        m.ticks.push(tick);
        m.finalPrice = tick.currentPrice; // last tick wins
        // keep first startPrice, in case it differs between files
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
  
  // Correlation tracking
  let correlationBlockCount = 0;
  let correlationBlockDetails = [];
  
  // Store all market results with timestamps for proper drawdown calculation
  const marketResults = [];

  // --- SIMULATION LOOP ---
  for (const slug in markets) {
    // Only check stopTrading if drawdown protection is enabled
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

      // Asset-specific edge requirement
      const minEdge = CONFIG.MIN_EDGE_BY_ASSET[m.symbol] || CONFIG.MIN_EDGE;
      
      // Drift adjustment
      if (CONFIG.USE_DRIFT) {
        const drift = estimateDrift(priceHistory.slice(0, i + 1));
        const minsElapsed = 15 - minsLeft;
        
        // Recalculate z with drift
        const sigmaT = sigmaPerMin * Math.sqrt(minsLeft);
        z = (tick.currentPrice - tick.startPrice - drift * minsElapsed) / sigmaT;
      }

      // Student's t-distribution
      if (CONFIG.USE_STUDENT_T) {
        const tScore = z / Math.sqrt(1 + z * z / 5);
        pUp = studentTCdf(tScore, 5);
        pDown = 1 - pUp;
      }

      // Regime adjustment
      let zReq;
      if (CONFIG.REGIME_INVERSION) {
        const volRatio = tick.volRatio || 1.0;
        const regimeScalar = Math.sqrt(volRatio);
        const baseZ = minsLeft > 3 ? CONFIG.Z_MIN_EARLY : CONFIG.Z_MIN_LATE;
        zReq = baseZ / Math.max(0.5, regimeScalar);
      } else {
        zReq = minsLeft > 3 ? CONFIG.Z_MIN_EARLY : CONFIG.Z_MIN_LATE;
      }

      // Trade size
      const modelProbForTrade = z > 0 ? pUp : pDown;
      const priceForTrade = z > 0 ? upAsk : downAsk;

      let intendedSize = 10;
      if (CONFIG.KELLY_SIZING && upAsk && downAsk && priceForTrade) {
        intendedSize = kellySize(
          modelProbForTrade,
          priceForTrade,
          CONFIG.MAX_SHARES,
          CONFIG.KELLY_FRACTION
        );
      }
      const fillFraction = getFillFraction(modelProbForTrade);
      let filledSize = Math.floor(intendedSize * fillFraction / 10) * 10; // keep 10-share granularity
      if (filledSize < 10) filledSize = 0; // nothing meaningful filled

      // --- UP LOGIC ---
      if (upAsk && z >= zReq) {
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
            z: z,
            ev: ev
          });
        }
      }

      // --- DOWN LOGIC ---
      if (downAsk && z <= -zReq) {
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
            size: filledSize,            // actual filled size
            intendedSize: intendedSize,  // NEW
            fillFraction: fillFraction,  // NEW
            marketSlug: slug,
            timestamp: tick.ts,
            z: z,
            ev: ev
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
      
      // Store result with settlement timestamp (end of market)
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

  // --- CALCULATE DRAWDOWN PROPERLY (after all results collected) ---
  // Sort by settlement time
  marketResults.sort((a, b) => a.timestamp - b.timestamp);
  
  console.log(`\n🔍 Calculating drawdown from ${marketResults.length} settled markets...`);
  
  let runningPnL = 0;
  let peak = 0;
  let maxDrawdown = 0; // RESET to 0 explicitly
  let everWentPositive = false;
  
  for (const result of marketResults) {
    runningPnL += result.pnl;
    
    // Only track peak once we've gone positive at least once
    if (runningPnL > 0) {
      if (!everWentPositive) {
        console.log(`✅ First positive PnL at ${runningPnL.toFixed(2)}`);
      }
      everWentPositive = true;
      if (runningPnL > peak) {
        peak = runningPnL;
      }
    }
    
    // Only calculate drawdown if we've established a positive peak
    if (everWentPositive && peak > 0) {
      const drawdown = (peak - runningPnL) / peak;
      if (drawdown > maxDrawdown && drawdown >= 0) {
        maxDrawdown = drawdown;
        console.log(`  New maxDD: ${(maxDrawdown*100).toFixed(1)}% at running PnL ${runningPnL.toFixed(2)} (peak was ${peak.toFixed(2)})`);
      }
    }
  }
  
  // If never went positive, drawdown is meaningless
  if (!everWentPositive) {
    console.log(`⚠️  Never went positive - setting drawdown to 0`);
    maxDrawdown = 0;
  }
  
  console.log(`Peak: ${peak.toFixed(2)}, Final: ${runningPnL.toFixed(2)}, MaxDD: ${(maxDrawdown*100).toFixed(1)}%`);
  
  // FORCE OVERWRITE - in case there's a stale value somewhere
  const finalMaxDrawdown = maxDrawdown;

  // --- ANALYSIS ---
  runDeepAnalysis(allTrades, markets);
  runAdvancedMetrics(allTrades, totalPnL, totalVolume);
  
  // --- CORRELATION ANALYSIS ---
  console.log("\n--- [F] CORRELATION RISK ANALYSIS ---");
  console.log(`Correlation Check: ${CONFIG.USE_CORRELATION_CHECK ? 'ENABLED' : 'DISABLED'}`);
  console.log(`Total Blocks: ${correlationBlockCount}`);
  
  if (correlationBlockCount > 0) {
    console.log(`\n⚠️  Correlation blocked ${correlationBlockCount} trades:`);
    
    // Group by asset
    const blocksByAsset = {};
    correlationBlockDetails.forEach(b => {
      if (!blocksByAsset[b.symbol]) blocksByAsset[b.symbol] = [];
      blocksByAsset[b.symbol].push(b);
    });
    
    Object.keys(blocksByAsset).sort().forEach(sym => {
      const blocks = blocksByAsset[sym];
      const totalSize = blocks.reduce((sum, b) => sum + b.size, 0);
      console.log(`  ${sym}: ${blocks.length} blocks, ${totalSize} shares blocked`);
    });
    
    // Show top 5 blocks
    console.log(`\nTop 5 Largest Blocks:`);
    correlationBlockDetails
      .sort((a, b) => b.risk - a.risk)
      .slice(0, 5)
      .forEach((b, i) => {
        console.log(
          `  ${i+1}. ${b.symbol} ${b.side} size=${b.size} ` +
          `(risk=${b.risk.toFixed(1)} > ${b.limit.toFixed(1)}) ${b.type || 'NORMAL'}`
        );
      });
  } else {
    console.log(`✅ No trades blocked by correlation risk`);
  }

  console.log("\n================ RESULTS ================");
  console.log(`Config: Z=${CONFIG.Z_MIN_EARLY}/${CONFIG.Z_MIN_LATE}, EDGE=${CONFIG.MIN_EDGE}, FEE=${CONFIG.FEE_BPS}bps`);
  console.log(`Features: Drift=${CONFIG.USE_DRIFT}, t-dist=${CONFIG.USE_STUDENT_T}, Regime=${CONFIG.REGIME_INVERSION}, Kelly=${CONFIG.KELLY_SIZING}`);
  console.log(`Max DD Stop: ${CONFIG.USE_MAX_DRAWDOWN ? 'ENABLED' : 'DISABLED'}`);
  console.log(`Markets Traded: ${wins + losses}`);
  console.log(`Win Rate: ${((wins / (wins + losses || 1)) * 100).toFixed(1)}%`);
  console.log(`Total Volume: ${totalVolume.toFixed(2)}`);
  console.log(`Max Drawdown: ${(finalMaxDrawdown * 100).toFixed(1)}%`);
  console.log(`TOTAL PnL: ${totalPnL.toFixed(2)}`);
  console.log(`Return on Volume: ${((totalPnL / totalVolume) * 100).toFixed(2)}%`);
  console.log("=========================================");
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
    "Early (>5m)": { pnl: 0, count: 0 },
    "Mid   (2-5m)": { pnl: 0, count: 0 },
    "Late  (<2m)": { pnl: 0, count: 0 },
  };

  trades.forEach(t => {
    const pnl = calculateTradePnL(t);
    let key = "Mid   (2-5m)";
    if (t.minsLeft > 5) key = "Early (>5m)";
    if (t.minsLeft < 2) key = "Late  (<2m)";
    
    timeStats[key].pnl += pnl;
    timeStats[key].count++;
  });

  for (const [key, stat] of Object.entries(timeStats)) {
    const avgPnL = stat.count > 0 ? stat.pnl / stat.count : 0;
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
    let bucket = "0.0-1.0";
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
  ["0.0-1.0", "1.0-1.5", "1.5-2.0", "2.0-3.0", "3.0+"].forEach(key => {
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
