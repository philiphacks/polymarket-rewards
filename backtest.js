import fs from "fs";
import readline from "readline";

// ================= CONFIG TO TEST =================
const CONFIG = {
  Z_MIN_EARLY: 1.0,
  Z_MIN_LATE: 0.7,
  MIN_EDGE: 0.03,    // 3% edge required
  MAX_SHARES: 500,
  FEE_BPS: 10,       // 10bps = 0.1% fee per trade (Simulating slippage + taker fee)
};
const allTrades = [];
// ==================================================

// CHANGE THIS TO YOUR ACTUAL LOG FILE NAME
const LOG_FILE = "ticks-20251121.jsonl"; 

async function runBacktest() {
  const fileStream = fs.createReadStream(LOG_FILE);
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  const markets = {}; 

  console.log("⏳ Parsing logs...");
  
  for await (const line of rl) {
    try {
      const tick = JSON.parse(line);
      // Group ticks by slug (unique market identifier)
      if (!markets[tick.slug]) {
        markets[tick.slug] = {
          symbol: tick.symbol,
          ticks: [],
          finalPrice: 0,
          startPrice: tick.startPrice,
          positions: { UP: 0, DOWN: 0, CASH: 0 },
        };
      }
      markets[tick.slug].ticks.push(tick);
      // Assume the last seen price is the settlement price
      markets[tick.slug].finalPrice = tick.currentPrice;
    } catch (e) { /* ignore corrupt lines */ }
  }

  console.log(`✅ Loaded ${Object.keys(markets).length} markets. Running simulation...\n`);

  let totalPnL = 0;
  let totalVolume = 0; // Fixed: Now updated
  let wins = 0;
  let losses = 0;

  // --- SIMULATION LOOP ---
  for (const slug in markets) {
    const m = markets[slug];
    
    // 1. Ensure Chronological Order (Critical for replay)
    m.ticks.sort((a, b) => a.ts - b.ts);

    // 2. Replay Ticks
    for (const tick of m.ticks) {
      const { z, pUp, pDown, upAsk, downAsk, minsLeft } = tick;
      
      const isEarly = minsLeft > 3;
      const zReq = isEarly ? CONFIG.Z_MIN_EARLY : CONFIG.Z_MIN_LATE;
      
      // We assume fixed size of 10 shares per click for granular testing
      const TRADE_SIZE = 10; 

      // --- UP LOGIC ---
      if (upAsk && z >= zReq) {
        const ev = pUp - upAsk;
        if (ev > CONFIG.MIN_EDGE) {
          // Pass 'totalVolume' by reference? No, in JS primitives are by value.
          // Easier to have executeTrade return the volume it generated.
          const vol = executeTrade(m, "UP", upAsk, TRADE_SIZE);
          totalVolume += vol;

          allTrades.push({
            symbol: m.symbol,
            side: "UP",
            entryPrice: upAsk,
            modelProb: pUp,
            minsLeft: minsLeft,
            size: TRADE_SIZE,
            marketSlug: slug
          });
        }
      }

      // --- DOWN LOGIC ---
      if (downAsk && z <= -zReq) {
        const ev = pDown - downAsk;
        if (ev > CONFIG.MIN_EDGE) {
          const vol = executeTrade(m, "DOWN", downAsk, TRADE_SIZE);
          totalVolume += vol;

          allTrades.push({
            symbol: m.symbol,
            side: "DOWN",
            entryPrice: downAsk,
            modelProb: pDown,
            minsLeft: minsLeft,
            size: TRADE_SIZE,
            marketSlug: slug
          });
        }
      }
    }

    // --- SETTLEMENT ---
    // If Final > Start, UP pays $1. Otherwise DOWN pays $1.
    const winner = m.finalPrice > m.startPrice ? "UP" : "DOWN";
    
    // Value of positions held
    const payout = (m.positions[winner] || 0) * 1.0; 
    
    // Net Profit = Cash (negative from buying) + Payout
    const netProfit = m.positions.CASH + payout;

    // Only log markets we traded in
    if (m.positions.UP > 0 || m.positions.DOWN > 0) {
      totalPnL += netProfit;
      if (netProfit > 0) wins++; else if (netProfit < 0) losses++;
      
      // Verbose log for big PnL swings
      if (Math.abs(netProfit) > 0.5) {
         console.log(
            `[${m.symbol}] Result:${winner} | Price: ${m.startPrice.toFixed(2)}->${m.finalPrice.toFixed(2)} | ` +
            `Pos: +${m.positions.UP}UP/+${m.positions.DOWN}DOWN | PnL: $${netProfit.toFixed(2)}`
         );
      }
    }
  }

  runDeepAnalysis(allTrades, markets);

  console.log("\n================ RESULTS ================");
  console.log(`Config: Z_EARLY=${CONFIG.Z_MIN_EARLY}, EDGE=${CONFIG.MIN_EDGE}, FEE=${CONFIG.FEE_BPS}bps`);
  console.log(`Total Markets Traded: ${wins + losses}`);
  console.log(`Win Rate: ${((wins / (wins + losses || 1)) * 100).toFixed(1)}%`);
  console.log(`Total Volume: $${totalVolume.toFixed(2)}`);
  console.log(`TOTAL PnL: $${totalPnL.toFixed(2)}`);
  console.log("=========================================");
}

function runDeepAnalysis(trades, marketsMap) {
  console.log("\n\n📊 ============ DEEP DIVE ANALYSIS ============");

  // Helper to calculate PnL per trade
  const calculateTradePnL = (trade) => {
    const m = marketsMap[trade.marketSlug];
    const winner = m.finalPrice > m.startPrice ? "UP" : "DOWN";
    
    // Did this specific trade win?
    const won = trade.side === winner;
    
    // Cost basis (including fee)
    const cost = trade.size * trade.entryPrice;
    const fee = cost * (CONFIG.FEE_BPS / 10000);
    const totalCost = cost + fee;
    
    // Payout ($1 per share if won, $0 if lost)
    const payout = won ? trade.size : 0;
    
    return payout - totalCost;
  };

  // ============================================
  // A. CALIBRATION CHECK (God View)
  // ============================================
  console.log("\n--- [A] CALIBRATION CHECK ---");
  console.log("(Does Model Probability match Win Rate?)");
  
  const buckets = {}; // "0.50", "0.55", "0.60"...
  
  trades.forEach(t => {
    const pnl = calculateTradePnL(t);
    const won = pnl > 0; // Rough approximation (or check outcome strictly)
    
    // Round probability to nearest 0.05 (5%)
    const bucket = (Math.floor(t.modelProb * 20) / 20).toFixed(2);
    
    if (!buckets[bucket]) buckets[bucket] = { total: 0, wins: 0, pnl: 0 };
    buckets[bucket].total++;
    if (won) buckets[bucket].wins++;
    buckets[bucket].pnl += pnl;
  });

  console.log("Prob Bucket | Trades | Actual Win% | Avg PnL/Trade");
  Object.keys(buckets).sort().forEach(b => {
    const d = buckets[b];
    const actualWinRate = (d.wins / d.total);
    const predicted = parseFloat(b);
    const diff = actualWinRate - predicted;
    const alert = Math.abs(diff) > 0.10 ? "⚠️" : "✅"; // Warn if >10% off
    
    console.log(
      `${b}-${(parseFloat(b)+0.05).toFixed(2)}   | ` +
      `${d.total.toString().padEnd(6)} | ` +
      `${(actualWinRate * 100).toFixed(1)}% ${alert}      | ` +
      `$${(d.pnl / d.total).toFixed(3)}`
    );
  });

  // ============================================
  // B. THE LATE GAME TRAP
  // ============================================
  console.log("\n--- [B] TIME ANALYSIS (Late Game Trap) ---");
  
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
    console.log(`${key} : PnL $${stat.pnl.toFixed(2)} (${stat.count} trades)`);
  }

  // ============================================
  // C. ASSET CORRELATION (Bad Asset Filter)
  // ============================================
  console.log("\n--- [C] ASSET PERFORMANCE ---");
  const assetStats = {};

  trades.forEach(t => {
    const pnl = calculateTradePnL(t);
    if (!assetStats[t.symbol]) assetStats[t.symbol] = { pnl: 0, vol: 0, trades: 0 };
    
    assetStats[t.symbol].pnl += pnl;
    assetStats[t.symbol].trades++;
    assetStats[t.symbol].vol += (t.size * t.entryPrice);
  });

  Object.keys(assetStats).forEach(sym => {
    const s = assetStats[sym];
    console.log(`[${sym}] PnL: $${s.pnl.toFixed(2)} | Trades: ${s.trades} | Vol: $${s.vol.toFixed(0)}`);
  });
  
  console.log("============================================\n");
}

function executeTrade(market, side, price, size) {
  const currentSize = market.positions[side] || 0;

  // Cap Check
  if (currentSize + size > CONFIG.MAX_SHARES) return 0;

  // Execution
  market.positions[side] += size;
  
  const rawCost = size * price;
  
  // Fee Calculation: (Cost * BPS) / 10000
  const fee = rawCost * (CONFIG.FEE_BPS / 10000);
  
  const totalCost = rawCost + fee;

  market.positions.CASH -= totalCost;
  
  // Return volume (raw cost) to be added to global total
  return rawCost; 
}

runBacktest();
