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
// ==================================================

// CHANGE THIS TO YOUR ACTUAL LOG FILE NAME
const LOG_FILE = "ticks-20251122.jsonl"; 

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
        }
      }

      // --- DOWN LOGIC ---
      if (downAsk && z <= -zReq) {
        const ev = pDown - downAsk;
        if (ev > CONFIG.MIN_EDGE) {
          const vol = executeTrade(m, "DOWN", downAsk, TRADE_SIZE);
          totalVolume += vol;
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

  console.log("\n================ RESULTS ================");
  console.log(`Config: Z_EARLY=${CONFIG.Z_MIN_EARLY}, EDGE=${CONFIG.MIN_EDGE}, FEE=${CONFIG.FEE_BPS}bps`);
  console.log(`Total Markets Traded: ${wins + losses}`);
  console.log(`Win Rate: ${((wins / (wins + losses || 1)) * 100).toFixed(1)}%`);
  console.log(`Total Volume: $${totalVolume.toFixed(2)}`);
  console.log(`TOTAL PnL: $${totalPnL.toFixed(2)}`);
  console.log("=========================================");
}

// Fixed: Now applies fees and returns the dollar volume traded
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
