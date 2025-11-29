// Version 2.4.1 - CRITICAL BUG FIXES
// FIXED: Exit blocked by stale Data API (prevented $282 SOL loss)
// FIXED: <30s exit threshold lowered to 1.2σ (prevented $86 ETH loss)
//
// Version 2.4.0 - Exit Mechanism & Position Management
// Key Changes from 2.3.2:
// - NEW: Exit mechanism for positions when signals reverse (CRITICAL FEATURE)
// - NEW: Reversal-based exits (0.8σ threshold after sign flip)
// - NEW: Emergency probability-based exits (>75% against position)
// - NEW: SELL order placement capability
// - IMPROVED: Position tracking with exit timestamps
//
// Previous version (2.3.2) fixed three critical bugs from 2.3.1:
// Bug #1: LATE_LAYER used 1.5σ threshold while main detector used 1.0σ
// Bug #2: Signal weakening logic used Math.abs() which lost sign information
// Bug #3: entryZ not stored if bot entered directly in LATE_LAYER mode
//
// Expected impact: 40-60% recovery on losing positions through active exits
// Combined with v2.3.2 fixes: 75-85% total loss reduction

import 'dotenv/config';
import cron from "node-cron";
import clob from "@polymarket/clob-client";
const { ClobClient, Side, OrderType } = clob;
import { Wallet } from "@ethersproject/wallet";
import fs from "fs";
import { VolatilityManager } from "./VolatilityManager.js";

// ---------- LOGGER FN (Buffered) --------------
function createScopedLogger(symbol) {
  const logs = [];
  const formatArgs = (args) => args.map(arg => {
    if (typeof arg === 'object') return JSON.stringify(arg);
    return arg;
  }).join(' ');

  return {
    log: (...args) => logs.push(`[${symbol}] ${formatArgs(args)}`),
    error: (...args) => logs.push(`[${symbol}] [ERROR] ${formatArgs(args)}`),
    warn: (...args) => logs.push(`[${symbol}] [WARN] ${formatArgs(args)}`),
    flush: () => {
      if (logs.length === 0) return;
      console.log(`\n--- START ${symbol} LOGS ---`);
      console.log(logs.join('\n'));
      console.log(`--- END ${symbol} LOGS ---\n`);
    }
  };
}

// ---------- GLOBAL CONFIG ----------
let interval = 2; // seconds between runs

const ASSETS = [
  { symbol: "BTC", slugPrefix: "btc", pythId: "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43" },
  { symbol: "ETH", slugPrefix: "eth", pythId: "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace" },
  { symbol: "SOL", slugPrefix: "sol", pythId: "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d" },
  { symbol: "XRP", slugPrefix: "xrp", pythId: "0xec5d399846a9209f3fe5881d70aae9268c94339ff9817e8d18ff19fa05eea1c8" },
];

const BASIS_BUFFER_BPS = {
  BTC: 5,
  ETH: 7,
  SOL: 7,
  XRP: 7
};

const MAX_PRICE_BY_TIME = {
  8: 0.86,
  5: 0.90,   // >5 mins
  3: 0.93,   // 3-5 mins
  2: 0.95,   // 2-3 mins
  1: 0.96,   // 1-2 mins
  0.5: 0.97, // 30s-1 min
  0: 0.98    // <30s
};
const MAX_RISK_REWARD_RATIO = 15;

const MAX_SHARES_PER_MARKET = { BTC: 600, ETH: 300, SOL: 300, XRP: 200 };

const ASSET_SPECIFIC_KELLY_FRACTION = {
  BTC: 0.15,
  ETH: 0.08,
  SOL: 0.15,
  XRP: 0.15
};

// Correlation matrix (for position limits)
const CORRELATION_MATRIX = {
  'BTC-ETH': 0.70,
  'BTC-SOL': 0.60,
  'BTC-XRP': 0.55,
  'ETH-SOL': 0.65,
  'ETH-XRP': 0.50,
  'SOL-XRP': 0.45
};

// EXIT CONFIGURATION (NEW in v2.4.0)
const EXIT_REVERSAL_THRESHOLD = 0.8; // Exit if signal reverses by this many σ after sign flip
const EXIT_PROBABILITY_THRESHOLD = 0.75; // Emergency exit if probability against position > 75%
const EXIT_MIN_POSITION_SIZE = 10; // Don't bother exiting positions smaller than this

// Time / edge thresholds
const MINUTES_LEFT = 3;
const MIN_EDGE_EARLY = 0.03;
const MIN_EDGE_LATE  = 0.02;

// EARLY TRADING CONFIG (5-15 mins left)
const OVERRIDE_US_TRADING_HOURS = true; // Toggle to trade early even during US hours
const ENABLE_EARLY_TRADING = true; // Toggle this to enable/disable early trading
const MAX_SHARES_WEAK_SIGNAL = 70;

// Regime scalar bounds (prevent extreme adjustments)
const REGIME_SCALAR_MIN = 0.7; // Don't make thresholds too high in low vol
const REGIME_SCALAR_MAX = 1.4; // Don't make thresholds too low in high vol

// Extreme late-game constants
const Z_HUGE = 2.8; // Requires ~99.7% probability
const LATE_GAME_EXTREME_SECS = 8;
const LATE_GAME_MIN_EV = 0.01;
const LATE_GAME_MAX_PRICE = 0.97;

// Risk bands
const PRICE_MIN_CORE = 0.90; const PROB_MIN_CORE  = 0.97;
const PRICE_MAX_RISKY = 0.90; const PROB_MAX_RISKY  = 0.95;
const MAX_REL_DIFF = 0.05;

// Order tracking
const ORDER_MONITOR_MS = 30000; // 30 seconds to fill
const pendingOrders = new Map(); // orderID -> { asset, side, size, timestamp }

// CLOB
const CLOB_HOST = "https://clob.polymarket.com";
const CHAIN_ID = 137;
const SIGNATURE_TYPE = 1;
const FUNDER = "0xA69b1867a00c87928b5A1f6B1c2e9aC2246bD844";

const signer = new Wallet(process.env.PRIVATE_KEY);
const creds = await new ClobClient(CLOB_HOST, CHAIN_ID, signer).createOrDeriveApiKey();
console.log("Address:", await signer.getAddress());
const client = new ClobClient(CLOB_HOST, CHAIN_ID, signer, creds, SIGNATURE_TYPE, FUNDER);

// ---------- STATISTICAL FUNCTIONS ----------

// Normal CDF
function normCdf(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp(-0.5 * z * z);
  let p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  if (z > 0) p = 1 - p;
  return p;
}

// Drift estimation (linear regression on recent prices) - WITH CLAMPING
const driftCache = {}; // symbol -> { drift, lastUpdate }

function estimateDrift(symbol, windowMinutes = 60) {
  const now = Date.now();
  
  if (driftCache[symbol] && now - driftCache[symbol].lastUpdate < 300000) {
    return driftCache[symbol].drift;
  }
  
  const history = VolatilityManager.getPriceHistory(symbol, windowMinutes);
  if (!history || history.length < 10) return 0;
  
  const n = history.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;

  const baseTime = history[0].timestamp;

  for (let i = 0; i < n; i++) {
    const x = (history[i].timestamp - baseTime) / 60000; // minutes
    const y = Math.log(history[i].price);
    sumX += x;
    sumY += y;
    sumXY += x * y;
    sumX2 += x * x;
  }
  
  const denominator = n * sumX2 - sumX * sumX;
  if (Math.abs(denominator) < 1e-10) return 0;
  
  const slope = (n * sumXY - sumX * sumY) / denominator;
  
  const currentPrice = history[history.length - 1].price;
  const driftPerMinute = slope * currentPrice;
  
  // Clamp drift to ±0.1% of price per minute (prevents extreme values)
  const maxDrift = currentPrice * 0.001; // 0.1%
  const clampedDrift = Math.max(-maxDrift, Math.min(maxDrift, driftPerMinute));
  
  driftCache[symbol] = { drift: clampedDrift, lastUpdate: now };
  return clampedDrift;
}

// Kelly Criterion for position sizing
function kellySize(prob, price, maxShares, fraction = 0.15) {
  // Edge cases
  if (price >= 0.99 || price <= 0.01) return 10; // fallback for extreme prices
  if (prob <= price) return 0; // no edge, minimum bet
  
  // Kelly formula for binary outcomes: (p - price) / (1 - price)
  // Where you pay 'price' and get $1 if you win
  const kellyFraction = (prob - price) / (1 - price);
  
  // Apply fractional Kelly for risk management
  const fractionalKelly = kellyFraction * fraction;
  
  // Convert to share size (as a fraction of max position)
  const rawSize = fractionalKelly * maxShares;
  
  // Round to nearest 10 shares, minimum 10
  const roundedSize = Math.max(10, Math.floor(rawSize / 10) * 10);
  
  // Cap at maxShares
  return Math.min(roundedSize, maxShares);
}

// Correlation-adjusted position limit check
function checkCorrelationRisk(state, newSymbol, newSide, newSize) {
  const positions = {};
  
  // Collect all current positions
  for (const [sym, st] of Object.entries(stateBySymbol)) {
    if (!st || !st.sideSharesBySlug) continue;
    const slug = st.slug;
    const pos = st.sideSharesBySlug[slug];
    if (!pos) continue;
    
    const net = (pos.UP || 0) - (pos.DOWN || 0);
    if (net !== 0) positions[sym] = net;
  }
  
  // Add proposed position
  const proposedNet = (positions[newSymbol] || 0) + (newSide === 'UP' ? newSize : -newSize);
  positions[newSymbol] = proposedNet;
  
  // Calculate correlation-adjusted exposure
  let totalRisk = 0;
  const symbols = Object.keys(positions);
  
  for (let i = 0; i < symbols.length; i++) {
    for (let j = 0; j < symbols.length; j++) {
      const sym1 = symbols[i];
      const sym2 = symbols[j];
      
      const pos1 = positions[sym1] || 0;
      const pos2 = positions[sym2] || 0;
      
      let corr = 1.0;
      if (sym1 !== sym2) {
        const key = [sym1, sym2].sort().join('-');
        corr = CORRELATION_MATRIX[key] || 0.5; // default to 0.5
      }
      
      totalRisk += pos1 * pos2 * corr;
    }
  }
  
  const portfolioStd = Math.sqrt(Math.max(0, totalRisk));
  
  // Risk limit: 3x average single-asset limit
  const avgLimit = Object.values(MAX_SHARES_PER_MARKET).reduce((a, b) => a + b, 0) / Object.keys(MAX_SHARES_PER_MARKET).length;
  const riskLimit = avgLimit * 3;
  
  return {
    ok: portfolioStd <= riskLimit,
    portfolioRisk: portfolioStd,
    limit: riskLimit
  };
}

function checkBasisRiskHybrid(currentPrice, startPrice, minsLeft, z, pUp, pDown, upAsk, downAsk, asset, logger, sharesUp = 0, sharesDown = 0) {
  if (minsLeft > 5) {
    const distFromStrike = (currentPrice - startPrice) / startPrice * 10000; // in bps
    
    // If price moved significantly against existing position, STOP
    if (distFromStrike < -20 && sharesUp > 0) {
      logger.log(`⛔ EARLY STOP: Price ${distFromStrike.toFixed(1)}bps below strike, holding ${sharesUp} UP`);
      return { safe: false, reason: "Price crossed strike early (UP position)" };
    }
    
    if (distFromStrike > 20 && sharesDown > 0) {
      logger.log(`⛔ EARLY STOP: Price ${distFromStrike.toFixed(1)}bps above strike, holding ${sharesDown} DOWN`);
      return { safe: false, reason: "Price crossed strike early (DOWN position)" };
    }
  }

  if (minsLeft >= 2) {
    return { safe: true, reason: "Not in danger zone" };
  }

  const distBps = (Math.abs(currentPrice - startPrice) / startPrice) * 10000;
  let minSafeDist = BASIS_BUFFER_BPS[asset.symbol] || 10;
  // TODO: consider removing this
  if (Math.abs(z) > 1.5) {
    minSafeDist *= 0.5;
  } else if (Math.abs(z) > 1.2) {
    minSafeDist *= 0.75;
  } else if (Math.abs(z) > 0.8) {
    minSafeDist *= 0.9;
  }
  
  if (distBps >= minSafeDist) {
    return { safe: true, reason: `Far from strike: ${distBps.toFixed(1)}bps` };
  }

  // In danger zone - apply strict rules
  const priceIsAboveStrike = currentPrice > startPrice;
  const absZ = Math.abs(z);
  
  // Calculate edge for both directions
  const upEdge = upAsk ? pUp - upAsk : 0;
  const downEdge = downAsk ? pDown - downAsk : 0;

  if (priceIsAboveStrike) {
    // Price above strike - UP is safer, DOWN is dangerous
    if (z > 0 && upEdge > 0.05) {
      // Trading WITH direction + good edge = allow
      logger.log(`✅ Basis OK: WITH direction (UP), edge=${(upEdge*100).toFixed(1)}%, dist=${distBps.toFixed(1)}bps`);
      return { safe: true, reason: "Trading with direction" };
    }
    if (z < 0) {
      // Trading AGAINST direction - need exceptional signal
      if (absZ > 2.0 && downEdge > 0.15) {
        logger.log(`⚠️  Basis override: Extreme signal (z=${z.toFixed(2)}, edge=${(downEdge*100).toFixed(1)}%)`);
        return { safe: true, reason: "Extreme counter-signal" };
      }
      logger.log(`🚫 BASIS RISK: Against direction, insufficient signal (z=${z.toFixed(2)})`);
      return { safe: false, reason: "Against direction in danger zone" };
    }
  } else {
    // Price below strike - DOWN is safer, UP is dangerous
    if (z < 0 && downEdge > 0.05) {
      logger.log(`✅ Basis OK: WITH direction (DOWN), edge=${(downEdge*100).toFixed(1)}%, dist=${distBps.toFixed(1)}bps`);
      return { safe: true, reason: "Trading with direction" };
    }
    if (z > 0) {
      if (absZ > 2.0 && upEdge > 0.15) {
        logger.log(`⚠️  Basis override: Extreme signal (z=${z.toFixed(2)}, edge=${(upEdge*100).toFixed(1)}%)`);
        return { safe: true, reason: "Extreme counter-signal" };
      }
      logger.log(`🚫 BASIS RISK: Against direction, insufficient signal (z=${z.toFixed(2)})`);
      return { safe: false, reason: "Against direction in danger zone" };
    }
  }

  logger.log(`🚫 BASIS RISK: Danger zone (${distBps.toFixed(1)}bps) with poor edge`);
  return { safe: false, reason: "Danger zone with insufficient edge" };
  // return { safe: true, reason: "No clear signal" };
}

function getMaxPriceForTime(minsLeft) {
  if (minsLeft > 8) return MAX_PRICE_BY_TIME[8];
  if (minsLeft > 5) return MAX_PRICE_BY_TIME[5];
  if (minsLeft > 3) return MAX_PRICE_BY_TIME[3];
  if (minsLeft > 2) return MAX_PRICE_BY_TIME[2];
  if (minsLeft > 1) return MAX_PRICE_BY_TIME[1];
  if (minsLeft > 0.5) return MAX_PRICE_BY_TIME[0.5];
  return MAX_PRICE_BY_TIME[0];
}

function checkRiskReward(price, size, prob, minsLeft, logger) {
  const reward = size * (1.00 - price);
  const risk = size * price;
  const ratio = risk / reward;

  // Calculate probability-adjusted max ratio
  // Higher probability = allow worse ratios
  // At 50% prob: max 15:1
  // At 90% prob: max 50:1
  // At 99% prob: max 200:1

  let maxRatio;
  if (prob >= 0.95) {
    // Very high probability: allow up to 100:1
    maxRatio = 100;
  } else if (prob >= 0.90) {
    // High probability: allow up to 50:1
    maxRatio = 50;
  } else if (prob >= 0.80) {
    // Medium-high: allow up to 25:1
    maxRatio = 25;
  } else {
    // Lower probability: strict 15:1
    maxRatio = 15;
  }

  if (ratio > maxRatio) {
    logger.log(`🛑 Risk/reward: ${ratio.toFixed(1)}:1 > ${maxRatio.toFixed(1)}:1 max (prob=${(prob*100).toFixed(1)}%)`);
    logger.log(`   Risking $${risk.toFixed(2)} to win $${reward.toFixed(2)}`);
    return false;
  }

  return true;
}

// ========================================
// EXIT LOGIC (NEW in v2.4.0)
// ========================================

function shouldExitPosition(state, z, pUp, pDown, sharesUp, sharesDown, minsLeft, logger) {
  const entryZ = state.entryZ;
  const totalShares = sharesUp + sharesDown;

  // No position or too small to bother
  if (totalShares < EXIT_MIN_POSITION_SIZE) {
    return { shouldExit: false };
  }

  // No entry signal recorded (shouldn't happen but be safe)
  if (entryZ === null || entryZ === undefined) {
    return { shouldExit: false };
  }

  if (minsLeft < 0.5) {
    const entrySignal = state.entryZ || 0;
    const currentSignal = z;
    const reversalMagnitude = Math.abs(currentSignal - entrySignal);
    const signalFlipped = Math.sign(entrySignal) !== Math.sign(currentSignal) && 
                          Math.sign(entrySignal) !== 0 && 
                          Math.sign(currentSignal) !== 0;

    // Allow exit if reversal >1.2σ (50% higher than normal to account for exit costs)
    if (!(signalFlipped && reversalMagnitude > 1.2)) {
      logger.log(`⏰ <30s left: only large reversals (>1.2σ) allowed, current: ${reversalMagnitude.toFixed(2)}σ`);
      return { shouldExit: false };
    }

    logger.log(`🚨 ULTRA-LATE EXIT: Reversal ${reversalMagnitude.toFixed(2)}σ with ${(minsLeft*60).toFixed(0)}s left`);
    // Allow exit to continue...
  }
  
  // EXIT CONDITION 1: Signal Reversal
  // Only triggers if sign has flipped AND magnitude is significant
  const currentZ = z;
  const signalFlipped = Math.sign(entryZ) !== Math.sign(currentZ) && 
                        Math.sign(entryZ) !== 0 && 
                        Math.sign(currentZ) !== 0;
  
  if (signalFlipped) {
    const reversalMagnitude = Math.abs(currentZ - entryZ);
    
    if (reversalMagnitude > EXIT_REVERSAL_THRESHOLD) {
      const exitSide = sharesUp > 0 ? 'UP' : 'DOWN';
      const exitShares = sharesUp > 0 ? sharesUp : sharesDown;
      
      logger.log(`🚨 SIGNAL REVERSAL DETECTED`);
      logger.log(`   Entry z=${entryZ.toFixed(2)} → Current z=${currentZ.toFixed(2)}`);
      logger.log(`   Reversal magnitude: ${reversalMagnitude.toFixed(2)}σ > ${EXIT_REVERSAL_THRESHOLD}σ threshold`);
      
      return {
        shouldExit: true,
        reason: 'signal_reversal',
        side: exitSide,
        shares: exitShares,
        urgency: 'normal',
        magnitude: reversalMagnitude
      };
    }
  }
  
  // EXIT CONDITION 2: Emergency Probability Override
  // If probability strongly favors opposite side, exit immediately
  if (sharesUp > 0 && pDown > EXIT_PROBABILITY_THRESHOLD) {
    logger.log(`🚨 EMERGENCY EXIT TRIGGERED`);
    logger.log(`   Holding ${sharesUp} UP shares but pDown=${(pDown*100).toFixed(1)}% (>${(EXIT_PROBABILITY_THRESHOLD*100).toFixed(0)}% threshold)`);
    
    return {
      shouldExit: true,
      reason: 'emergency_probability',
      side: 'UP',
      shares: sharesUp,
      urgency: 'emergency',
      probability: pDown
    };
  }
  
  if (sharesDown > 0 && pUp > EXIT_PROBABILITY_THRESHOLD) {
    logger.log(`🚨 EMERGENCY EXIT TRIGGERED`);
    logger.log(`   Holding ${sharesDown} DOWN shares but pUp=${(pUp*100).toFixed(1)}% (>${(EXIT_PROBABILITY_THRESHOLD*100).toFixed(0)}% threshold)`);
    
    return {
      shouldExit: true,
      reason: 'emergency_probability',
      side: 'DOWN',
      shares: sharesDown,
      urgency: 'emergency',
      probability: pUp
    };
  }
  
  return { shouldExit: false };
}

/**
 * Get actual token positions from Polymarket Data API
 * This queries the real on-chain positions, not just what we think we have
 */
async function getActualPositions(userAddress, tokenIds, logger) {
  try {
    const [upTokenId, downTokenId] = tokenIds;
    
    // Query Data API for user's positions
    const url = `https://data-api.polymarket.com/positions?user=${userAddress}`;
    
    logger.log(`🔍 Querying Data API for actual positions...`);
    
    const response = await fetch(url);
    
    if (!response.ok) {
      logger.error(`Data API returned ${response.status}: ${response.statusText}`);
      return null;
    }
    
    const positions = await response.json();
    
    if (!Array.isArray(positions)) {
      logger.error(`Data API returned unexpected format: ${typeof positions}`);
      return null;
    }
    
    // Find positions matching our token IDs
    let upShares = 0;
    let downShares = 0;
    
    for (const position of positions) {
      const asset = position.asset;
      const size = Number(position.size || 0);
      
      if (asset === upTokenId) {
        upShares = size;
        logger.log(`   UP: ${size} shares @ avg $${position.avgPrice?.toFixed(3)}`);
      } else if (asset === downTokenId) {
        downShares = size;
        logger.log(`   DOWN: ${size} shares @ avg $${position.avgPrice?.toFixed(3)}`);
      }
    }
    
    logger.log(`   Total: ${upShares} UP, ${downShares} DOWN`);
    
    return { UP: upShares, DOWN: downShares };
    
  } catch (err) {
    logger.error(`Failed to get actual positions: ${err.message}`);
    return null;
  }
}

/**
 * Reconcile tracked positions with actual on-chain positions
 * CRITICAL: Must account for pending orders that haven't filled yet
 */
async function reconcilePositions(state, logger) {
  try {
    const { tokenIds, slug } = state.marketMeta;
    const [upTokenId, downTokenId] = tokenIds;
    
    // Check if we have pending orders for THIS specific market
    const pendingForMarket = Array.from(pendingOrders.entries())
      .filter(([orderId, data]) => data.slug === slug);
    
    if (pendingForMarket.length > 0) {
      // Check age of oldest order
      const oldestTimestamp = Math.min(...pendingForMarket.map(([id, data]) => data.timestamp));
      const age = Date.now() - oldestTimestamp;
      
      if (age < 30000) {
        // Orders < 30s old - definitely wait
        logger.log(`⏳ Skipping reconciliation: ${pendingForMarket.length} pending orders <30s old`);
        return;
      } else if (age < 60000) {
        // Orders 30-60s old - probably still filling, wait unless critical
        logger.log(`⏳ Skipping reconciliation: pending orders ${(age/1000).toFixed(0)}s old (waiting for settlement)`);
        return;
      } else {
        // Orders >60s old - likely settled (even if partially), safe to reconcile
        logger.warn(`⚠️  Reconciling despite ${pendingForMarket.length} pending: orders ${(age/1000).toFixed(0)}s old (likely settled)`);
        // Continue to reconciliation
      }
    }
    
    const actual = await getActualPositions(FUNDER, tokenIds, logger);
    
    if (!actual) return;
    
    const tracked = state.sideSharesBySlug[slug] || { UP: 0, DOWN: 0 };
    
    const upDiff = Math.abs(actual.UP - tracked.UP);
    const downDiff = Math.abs(actual.DOWN - tracked.DOWN);
    
    // Only reconcile if significant difference (>5 shares or >10%)
    const upThreshold = Math.max(5, tracked.UP * 0.1);
    const downThreshold = Math.max(5, tracked.DOWN * 0.1);
    
    if (upDiff > upThreshold || downDiff > downThreshold) {
      logger.warn(`📊 POSITION RECONCILIATION NEEDED`);
      logger.warn(`   UP: Tracked ${tracked.UP} → Actual ${actual.UP} (diff: ${upDiff})`);
      logger.warn(`   DOWN: Tracked ${tracked.DOWN} → Actual ${actual.DOWN} (diff: ${downDiff})`);
      
      let shouldReconcile = false;
      let reconcileReason = '';
      
      // RULE 1: Actual > Tracked = fills came in, always safe
      if (actual.UP > tracked.UP || actual.DOWN > tracked.DOWN) {
        shouldReconcile = true;
        reconcileReason = 'Actual > Tracked (fills came in)';
      }
      
      // RULE 2: Both zero = market expired or fully exited
      else if (actual.UP === 0 && actual.DOWN === 0 && (tracked.UP > 0 || tracked.DOWN > 0)) {
        shouldReconcile = true;
        reconcileReason = 'Both positions zero (expired/exited)';
      }
      
      // RULE 3: Partial fill - tracked > actual but actual > 0
      else if (tracked.UP > actual.UP && actual.UP > 0 && tracked.DOWN === 0) {
        shouldReconcile = true;
        reconcileReason = `Partial fill: UP ${tracked.UP} → ${actual.UP}`;
      }
      else if (tracked.DOWN > actual.DOWN && actual.DOWN > 0 && tracked.UP === 0) {
        shouldReconcile = true;
        reconcileReason = `Partial fill: DOWN ${tracked.DOWN} → ${actual.DOWN}`;
      }
      
      // RULE 4: Single position decreased (exit or sale)
      else if (tracked.UP === 0 && actual.DOWN < tracked.DOWN && tracked.DOWN > 0) {
        shouldReconcile = true;
        reconcileReason = `DOWN decreased ${tracked.DOWN} → ${actual.DOWN}`;
      }
      else if (tracked.DOWN === 0 && actual.UP < tracked.UP && tracked.UP > 0) {
        shouldReconcile = true;
        reconcileReason = `UP decreased ${tracked.UP} → ${actual.UP}`;
      }
      
      // RULE 5: Don't reconcile - probably pending fills
      else {
        logger.warn(`⚠️  NOT reconciling: Tracked > Actual suggests pending fills`);
        logger.warn(`   This is expected immediately after placing orders`);
        logger.warn(`   Will reconcile after orders complete or on next cycle`);
        return;
      }

      if (shouldReconcile) {
        logger.log(`✅ Reconciling: ${reconcileReason}`);
        state.sideSharesBySlug[slug] = { UP: actual.UP, DOWN: actual.DOWN };
        logger.log(`✅ Positions reconciled to actual values`);
      }
    }
  } catch (err) {
    logger.error(`Position reconciliation failed: ${err.message}`);
  }
}

async function executeExit(asset, state, exitDecision, upBook, downBook, logger) {
  const { side, shares, urgency, reason } = exitDecision;
  const { tokenIds, slug } = state.marketMeta;
  const [upTokenId, downTokenId] = tokenIds;
  
  // ========================================
  // CRITICAL FIX: Verify actual position before exiting
  // sideSharesBySlug tracks orders placed, not actual fills!
  // Must query Data API to get real position
  // ========================================
  
  logger.log(`🔍 Verifying actual position before exit...`); 
  const actualPositions = await getActualPositions(
    FUNDER, // The funder address from config
    tokenIds,
    logger
  );
  
  const trackedShares = shares;
  let sharesToExit = trackedShares; // Default to tracked
  
  // Handle API failure - DON'T BLOCK EXIT
  if (!actualPositions) {
    logger.warn(`⚠️  Data API failed - proceeding with tracked position`);
    logger.warn(`   Tracked: ${trackedShares} ${side} shares`);
    logger.warn(`   Risk: May attempt to sell more than we have (exchange will reject gracefully)`);
    // Continue with tracked shares - better to try and fail than not try at all
    sharesToExit = trackedShares;
  } else {
    // API returned data - verify it
    const actualShares = side === 'UP' ? actualPositions.UP : actualPositions.DOWN;
    
    // Check for discrepancy
    if (Math.abs(actualShares - trackedShares) > 5) {
      logger.warn(`⚠️  POSITION MISMATCH DETECTED!`);
      logger.warn(`   Tracked: ${trackedShares} ${side}`);
      logger.warn(`   Actual:  ${actualShares} ${side}`);
      logger.warn(`   Difference: ${trackedShares - actualShares} shares (${((Math.abs(trackedShares - actualShares)) / Math.max(trackedShares, 1) * 100).toFixed(1)}%)`);
      
      // Decision logic:
      // 1. If actual > 0, use actual (API is correct, fills came in)
      // 2. If actual = 0 but tracked > 20, trust tracked (API may be stale)
      // 3. If both small, abort (likely already exited)
      
      if (actualShares > 0) {
        logger.log(`   Using actual: ${actualShares} shares (API has real data)`);
        sharesToExit = actualShares;
      } else if (actualShares === 0 && trackedShares >= 20) {
        logger.warn(`   ⚠️  CRITICAL: API shows 0 but tracked is ${trackedShares} - API likely stale!`);
        logger.warn(`   Proceeding with tracked position (better to try than skip)`);
        logger.warn(`   If this fails, exchange will reject gracefully`);
        sharesToExit = trackedShares;
      } else {
        // Both are small or actual=0 and tracked<20
        logger.warn(`⚠️  Both actual (${actualShares}) and tracked (${trackedShares}) small - likely already exited`);
        
        // Update state to match reality
        if (side === 'UP') {
          state.sideSharesBySlug[slug].UP = actualShares;
        } else {
          state.sideSharesBySlug[slug].DOWN = actualShares;
        }
        
        return false;
      }
    } else {
      logger.log(`✅ Position verified: ${actualShares} ${side} shares`);
      sharesToExit = actualShares;
    }
  }
  
  // Final check: only abort if position is truly tiny
  if (sharesToExit < EXIT_MIN_POSITION_SIZE) {
    logger.warn(`⚠️  Position too small to exit: ${sharesToExit} shares (min ${EXIT_MIN_POSITION_SIZE})`);
    
    // Update state
    if (side === 'UP') {
      state.sideSharesBySlug[slug].UP = sharesToExit;
    } else {
      state.sideSharesBySlug[slug].DOWN = sharesToExit;
    }
    
    return false;
  }
  
  // Update exitDecision with final share count
  exitDecision.shares = sharesToExit;
  
  // Continue with exit using determined shares
  const tokenId = side === 'UP' ? upTokenId : downTokenId;
  const orderBook = side === 'UP' ? upBook : downBook;
  
  const { bestBid } = getBestBidAsk(orderBook);
  
  if (!bestBid) {
    logger.error(`❌ Cannot exit ${side}: No bid available`);
    return false;
  }
  
  // Determine sell price based on urgency
  let sellPrice;
  if (urgency === 'emergency') {
    // Very aggressive: 2 ticks below best bid for guaranteed fast fill
    sellPrice = Math.max(0.01, Math.min(0.99, bestBid - 0.02));
  } else {
    // Normal: 1 tick below best bid for fast fill
    sellPrice = Math.max(0.01, Math.min(0.99, bestBid - 0.01));
  }

  const expectedRecovery = sharesToExit * sellPrice;

  logger.log(`🚨 EXECUTING EXIT`);
  logger.log(`   Selling: ${sharesToExit} ${side} shares @ $${sellPrice.toFixed(2)}`);
  logger.log(`   Reason: ${reason} | Urgency: ${urgency}`);
  logger.log(`   Expected recovery: $${expectedRecovery.toFixed(2)}`);
  
  try {
    const resp = await client.createAndPostOrder({
      tokenID: tokenId,
      price: sellPrice.toFixed(2),
      side: Side.SELL,  // CRITICAL: Use SELL not BUY
      size: sharesToExit,
      expiration: String(Math.floor(Date.now()/1000) + 300) // 5 min expiry
    }, { tickSize: "0.01", negRisk: false }, OrderType.GTD);
    
    if (resp && resp.orderID) {
      logger.log(`✅ Exit order placed successfully: ${resp.orderID}`);
      
      // Log the exit order
      logOrderAttempt({
        ts: Date.now(),
        symbol: asset.symbol,
        orderID: resp.orderID,
        side: side,
        price: sellPrice,
        size: sharesToExit,
        type: "EXIT",
        reason: reason,
        urgency: urgency,
        expectedRecovery: expectedRecovery,
        trackedShares: trackedShares,
        actualShares: sharesToExit
      });
      
      // Update position to zero (we sold entire position)
      if (side === 'UP') {
        state.sideSharesBySlug[slug].UP = 0;
      } else {
        state.sideSharesBySlug[slug].DOWN = 0;
      }
      
      // Clear entry Z since we've exited the position
      state.entryZ = null;
      state.minZSinceEntry = null;
      state.exitTimestamp = Date.now();

      const pos = state.sideSharesBySlug[slug];
      if (pos.UP === 0 && pos.DOWN === 0) {
        state.sharesBoughtBySlug[slug] = 0;
        logger.log(`✅ Full exit - reset bought counter`);
      }

      return true;
    }
  } catch (err) {
    logger.error(`❌ Exit order failed: ${err.message}`);
    return false;
  }
  
  return false;
}

// ---------- UTILS ----------

function current15mStartUnix(date = new Date()) {
  const ms = date.getTime();
  const intervalMs = 15 * 60 * 1000;
  return Math.floor(ms / intervalMs) * (intervalMs / 1000);
}

function crypto15mSlug(slugPrefix, date = new Date()) {
  return `${slugPrefix}-updown-15m-${current15mStartUnix(date)}`;
}

function current15mStartUTC(date = new Date()) {
  const d = new Date(date);
  d.setUTCMinutes(Math.floor(d.getUTCMinutes() / 15) * 15, 0, 0);
  return d;
}

function current15mEndUTC(date = new Date()) {
  const start = current15mStartUTC(date);
  return new Date(start.getTime() + 15 * 60 * 1000);
}

function isoNoMs(d) {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function cryptoPriceUrl({ symbol, date = new Date(), variant = "fifteen" }) {
  const start = current15mStartUTC(date);
  const end = current15mEndUTC(date);
  const params = new URLSearchParams({ symbol, eventStartTime: isoNoMs(start), variant, endDate: isoNoMs(end) });
  return `https://polymarket.com/api/crypto/crypto-price?${params.toString()}`;
}

// Time decay INCREASES volatility near expiry (gamma risk)
function getTimeDecayFactor(minsLeft) {
  if (minsLeft >= 1) return 1.0;
  
  const secsLeft = minsLeft * 60;
  if (secsLeft >= 30) return 1.0;
  
  // Increase vol by up to 40% in final 30 seconds
  const t = Math.max(0, Math.min(1, (30 - secsLeft) / 30));
  return 1.0 + t * 0.4; // 1.0 -> 1.4
}

function canPlaceOrder(state, slug, side, size, assetSymbol) {
  const totalCap = MAX_SHARES_PER_MARKET[assetSymbol] || 500;
  const totalBefore = state.sharesBoughtBySlug[slug] || 0;
  const pos = state.sideSharesBySlug[slug] || { UP: 0, DOWN: 0 };
  const netBefore = (pos.UP || 0) - (pos.DOWN || 0);
  const sideSign = side === "UP" ? 1 : -1;
  const netAfter = netBefore + sideSign * size;
  const totalAfter = totalBefore + size;

  if (totalAfter <= totalCap) return { ok: true, reason: "within_cap", totalBefore, totalAfter, netBefore, netAfter };
  if (Math.abs(netAfter) < Math.abs(netBefore)) return { ok: true, reason: "hedge_beyond_cap", totalBefore, totalAfter, netBefore, netAfter };
  
  return { ok: false, reason: "risk_increase_beyond_cap", totalBefore, totalAfter, netBefore, netAfter };
}

function getBestBidAsk(ob) {
  let bestBid = null, bestAsk = null;
  if (ob.bids?.length) bestBid = ob.bids.reduce((max, o) => Math.max(max, Number(o.price)), -Infinity);
  if (ob.asks?.length) bestAsk = ob.asks.reduce((min, o) => Math.min(min, Number(o.price)), Infinity);
  return { bestBid: Number.isFinite(bestBid) ? bestBid : null, bestAsk: Number.isFinite(bestAsk) ? bestAsk : null };
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function getExistingSide(state, slug) {
  const pos = state.sideSharesBySlug?.[slug];
  if (!pos) return null;
  if ((pos.UP || 0) > (pos.DOWN || 0)) return "UP";
  if ((pos.DOWN || 0) > (pos.UP || 0)) return "DOWN";
  return null;
}

function addPosition(state, slug, side, size) {
  if (!state.sideSharesBySlug[slug]) state.sideSharesBySlug[slug] = { UP: 0, DOWN: 0 };
  state.sideSharesBySlug[slug][side] = (state.sideSharesBySlug[slug][side] || 0) + size;
}

function requiredLateProb(secsLeft) {
  const maxSecs = 120, pHigh = 0.90, pLow = 0.85;
  const clamped = Math.max(0, Math.min(maxSecs, secsLeft));
  const t = (maxSecs - clamped) / maxSecs;
  return pHigh + (pLow - pHigh) * t;
}

function isInSlamWindow(date = new Date()) {
  const totalMins = date.getUTCHours() * 60 + date.getUTCMinutes();
  return totalMins >= 14 * 60 + 45 && totalMins < 15 * 60;
}

function isUSTradingHours(date = new Date()) {
  const totalMins = date.getUTCHours() * 60 + date.getUTCMinutes();
  const dayOfWeek = date.getUTCDay(); // 0=Sunday, 1=Monday, ..., 6=Saturday
  
  // Only Monday-Friday (1-5), not weekends (0, 6)
  const isWeekday = dayOfWeek >= 1 && dayOfWeek <= 5;
  const isInTimeRange = totalMins >= 13 * 60 + 45 && totalMins < 20 * 60 + 30;
  
  return !OVERRIDE_US_TRADING_HOURS && isWeekday && isInTimeRange;
}

// Logging
function logTickSnapshot(snapshot) {
  try {
    const d = new Date(snapshot.ts);
    const filename = `ticks-${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}.jsonl`;
    fs.appendFile(filename, JSON.stringify(snapshot) + "\n", (err) => { if (err) console.error("[TICK-LOG] Error:", err); });
  } catch (err) { console.error("[TICK-LOG] Failed:", err); }
}

function logOrderAttempt(orderData) {
  try {
    const filename = `orders-${new Date().toISOString().slice(0,10)}.jsonl`;
    const isUSHours = isUSTradingHours(new Date(orderData.ts));
    orderData.session = isUSHours ? 'US' : 'NON-US';
    fs.appendFile(filename, JSON.stringify(orderData) + "\n", (err) => { 
      if (err) console.error("[ORDER-LOG] Failed:", err); 
    });
  } catch (e) { console.error("[ORDER-LOG] Error:", e); }
}

// Smart Sizing
function sizeForTrade(ev, minsLeft, opts = {}) {
  const { minEdgeOverride = null, riskBand = "medium" } = opts;
  const minEdge = minEdgeOverride !== null ? minEdgeOverride : (minsLeft > MINUTES_LEFT ? MIN_EDGE_EARLY : MIN_EDGE_LATE);
  if (ev <= minEdge) return 0;

  let BASE_MIN, BASE_MAX, ABS_MAX, EV_CAP;
  if (riskBand === "core") { BASE_MIN = 60; BASE_MAX = 180; ABS_MAX = 250; EV_CAP = 0.18; }
  else if (riskBand === "risky") { BASE_MIN = 10; BASE_MAX = 40; ABS_MAX = 60; EV_CAP = 0.08; }
  else { BASE_MIN = 40; BASE_MAX = 120; ABS_MAX = 160; EV_CAP = 0.12; }

  const effectiveMax = Math.max(EV_CAP, minEdge + 0.01);
  const evNorm = Math.min(1, (Math.min(ev, EV_CAP) - minEdge) / (effectiveMax - minEdge));
  const clampedMins = Math.max(0, Math.min(MINUTES_LEFT, minsLeft));
  const timeFactor = 0.7 + 0.6 * (1 - clampedMins / MINUTES_LEFT);

  let size = BASE_MIN + evNorm * (BASE_MAX - BASE_MIN);
  size = Math.round((size * timeFactor) / 10) * 10;
  
  return Math.min(size, ABS_MAX);
}

// ---------- ORDER MONITORING ----------

async function monitorAndCancelOrder(orderID, asset, side, size, logger) {
  const startTime = Date.now();
  
  try {
    while (Date.now() - startTime < ORDER_MONITOR_MS) {
      await sleep(5000); // Check every 5 seconds
      
      try {
        const order = await client.getOrder(orderID);
        
        if (!order) {
          logger.warn(`Order ${orderID} not found`);
          pendingOrders.delete(orderID);
          break;
        }
        
        // Check if filled
        const sizeFilled = Number(order.size_matched || 0);
        if (sizeFilled >= size * 0.95) { // 95% filled = success
          logger.log(`✅ Order ${orderID} filled: ${sizeFilled}/${size}`);
          pendingOrders.delete(orderID);
          return { filled: true, sizeFilled };
        }
        
        // Check if cancelled or failed
        if (order.status === 'CANCELLED' || order.status === 'FAILED') {
          logger.warn(`Order ${orderID} ${order.status}`);
          pendingOrders.delete(orderID);
          return { filled: false, status: order.status };
        }
        
      } catch (err) {
        // Don't spam logs on temporary errors
        if (Date.now() - startTime > ORDER_MONITOR_MS - 10000) {
          logger.error(`Error checking order ${orderID}: ${err.message}`);
        }
      }
    }
    
    // Timeout - cancel the order
    logger.warn(`⏱️ Order ${orderID} timeout after ${ORDER_MONITOR_MS}ms - cancelling`);
    
    try {
      await client.cancelOrder(orderID);
      logger.log(`Cancelled order ${orderID}`);
    } catch (cancelErr) {
      logger.error(`Failed to cancel ${orderID}: ${cancelErr.message}`);
    }
    
    pendingOrders.delete(orderID);
    return { filled: false, status: 'TIMEOUT' };
    
  } catch (err) {
    logger.error(`Monitor error for ${orderID}: ${err.message}`);
    pendingOrders.delete(orderID);
    return { filled: false, status: 'ERROR' };
  }
}

// ---------- STATE & EXECUTION ----------
const stateBySymbol = {};
const executionLock = {}; // Prevent race conditions

function ensureState(asset, logger) {
  if (!stateBySymbol[asset.symbol]) {
    const slug = crypto15mSlug(asset.slugPrefix);
    stateBySymbol[asset.symbol] = {
      slug,
      cryptoPriceUrl: cryptoPriceUrl({ symbol: asset.symbol }),
      gammaUrl: `https://gamma-api.polymarket.com/markets/slug/${slug}`,
      sharesBoughtBySlug: { [slug]: 0 },
      sideSharesBySlug: { [slug]: { UP: 0, DOWN: 0 } },
      resetting: false,
      cpData: null,
      marketMeta: null,
      zHistory: [],
      entryZ: null,  // Store entry z-score for reversal detection
      exitTimestamp: null,  // NEW in v2.4.0: Track when we last exited
      weakSignalCount: 0,
      weakSignalHistory: [],
      liquidityHistory: [],
      minZSinceEntry: null
    };
    console.log(`[${asset.symbol}] Reset state for ${slug}`);

    for (const [orderID, data] of pendingOrders.entries()) {
      logger.warn(`🧹 Cleaning stale order: ${orderID}`);
      pendingOrders.delete(orderID);
    }
  }
  return stateBySymbol[asset.symbol];
}

async function execForAsset(asset, priceData) {
  const logger = createScopedLogger(asset.symbol);

  // Prevent concurrent execution
  if (executionLock[asset.symbol]) {
    logger.log("Skipping - already executing");
    return;
  }
  
  executionLock[asset.symbol] = true;

  try {
    const state = ensureState(asset, logger);
    if (state.resetting) return;
    const { slug, cryptoPriceUrl, gammaUrl } = state;

    logger.log(`\n\n===== ${asset.symbol} | slug=${slug} =====`);

    // 1) Gamma Meta
    if (!state.marketMeta || state.marketMeta.slug !== slug) {
      const gammaRes = await fetch(gammaUrl);
      if (!gammaRes.ok) { 
        logger.error(`Gamma failed: ${gammaRes.status}`); 
        return; 
      }
      const market = await gammaRes.json();
      state.marketMeta = {
        id: market.id, slug, question: market.question,
        endMs: new Date(market.endDate).getTime(),
        tokenIds: JSON.parse(market.clobTokenIds),
        endDate: market.endDate
      };
      logger.log(`Cached meta for ${market.id}`);
    }

    const { endMs, tokenIds } = state.marketMeta;
    const minsLeft = Math.max((endMs - Date.now()) / 60000, 0.001);
    logger.log(`Mins left: ${minsLeft.toFixed(3)}`);

    // Interval End Handling
    if (minsLeft < 0.01) {
      state.resetting = true;
      logger.log(`Interval over. Resetting...`);

      state.sharesBoughtBySlug[slug] = 0;
      logger.log(`✅ Market expired - reset bought counter to 0`);

      await sleep(30_000);
      stateBySymbol[asset.symbol] = null;
      return;
    }
    if (isInSlamWindow()) return;
    if (minsLeft > 14) return;

    // 2) Start Price
    let startPrice;
    if (state.cpData?.openPrice) {
      startPrice = Number(state.cpData.openPrice);
    } else {
      const cpRes = await fetch(cryptoPriceUrl);
      if (cpRes.status === 429) { 
        await sleep(3000); 
        return; 
      }
      if (!cpRes.ok) {
        logger.error(`Crypto price API failed: ${cpRes.status}`);
        return;
      }
      const cp = await cpRes.json();
      if (Number(cp.openPrice) > 0) {
        state.cpData = { ...cp, _cachedAt: Date.now() };
        startPrice = Number(cp.openPrice);
        logger.log(`Start Price cached: ${startPrice}`);
      } else {
        logger.error(`Invalid openPrice: ${cp.openPrice}`);
        return;
      }
    }

    // 3) Current Price & Sanity
    const currentPrice = priceData.price;
    logger.log(`Open $${startPrice.toFixed(4)} | Curr $${currentPrice.toFixed(4)}`);

    if (Math.abs(currentPrice - startPrice) / startPrice > MAX_REL_DIFF) {
      logger.log(`Price sanity FAILED. Skipping.`);
      return;
    }

    // 4) Volatility & Drift
    let rawSigmaPerMin = VolatilityManager.getRealizedVolatility(asset.symbol, currentPrice);
    const drift = estimateDrift(asset.symbol, 60);

    const effectiveSigma = rawSigmaPerMin * getTimeDecayFactor(minsLeft);
    const volRatio = VolatilityManager.getVolRegimeRatio(asset.symbol, rawSigmaPerMin);

    // Regime scalar clamped to prevent extreme adjustments
    const rawRegimeScalar = Math.sqrt(volRatio);
    const regimeScalar = Math.max(REGIME_SCALAR_MIN, Math.min(REGIME_SCALAR_MAX, rawRegimeScalar));

    const sigmaT = effectiveSigma * Math.sqrt(minsLeft);

    // Include drift in z-score calculation
    const z = (currentPrice - startPrice + drift * minsLeft) / sigmaT;
    if (!state.zHistory) state.zHistory = [];
    state.zHistory.push({ z, ts: Date.now() });
    state.zHistory = state.zHistory.filter(h => Date.now() - h.ts < 30000);

    // Use normal distribution (well-calibrated for our use case)
    const pUp = normCdf(z);
    const pDown = 1 - pUp;

    logger.log(
      `σ_raw: $${rawSigmaPerMin.toFixed(4)} (Ratio: ${volRatio.toFixed(2)}x, Scalar: ${rawRegimeScalar.toFixed(2)}x -> ${regimeScalar.toFixed(2)}x clamped) | ` +
      `Drift: $${drift.toFixed(4)}/min | z: ${z.toFixed(3)}`
    );

    // 5) Order Books
    const [upTokenId, downTokenId] = tokenIds;
    const [upBook, downBook] = await Promise.all([
      client.getOrderBook(upTokenId), 
      client.getOrderBook(downTokenId)
    ]);
    const { bestAsk: upAsk } = getBestBidAsk(upBook);
    const { bestAsk: downAsk } = getBestBidAsk(downBook);

    const mid = (upAsk && downAsk) ? (upAsk + downAsk) / 2 : (upAsk || downAsk);
    logger.log(`Up ask / Down ask: ${upAsk?.toFixed(3) ?? 'n/a'} / ${downAsk?.toFixed(3) ?? 'n/a'}, mid≈${mid?.toFixed(3) ?? 'n/a'}`);

    if (!upAsk && !downAsk) { 
      logger.log("No asks."); 
      return; 
    }

    const existingSide = getExistingSide(state, slug);
    logger.log(`Existing net side: ${existingSide || "FLAT"}`);

    const pos = state.sideSharesBySlug[slug] || { UP: 0, DOWN: 0 };
    const totalBought = state.sharesBoughtBySlug[slug] || 0;
    const netPosition = pos.UP - pos.DOWN;

    logger.log(`📊 POSITION DEBUG:`);
    logger.log(`   sideSharesBySlug[${slug}]: UP=${pos.UP}, DOWN=${pos.DOWN}`);
    logger.log(`   sharesBoughtBySlug[${slug}]: ${totalBought}`);
    logger.log(`   Net position: ${netPosition} (${netPosition > 0 ? 'UP' : netPosition < 0 ? 'DOWN' : 'FLAT'})`);
    logger.log(`   Cap: ${totalBought}/${MAX_SHARES_PER_MARKET[asset.symbol]}`);

    // Also log all slugs in state:
    logger.log(`   All tracked slugs: ${Object.keys(state.sharesBoughtBySlug).join(', ')}`);

    const sharesUp = state.sideSharesBySlug[slug]?.UP || 0;
    const sharesDown = state.sideSharesBySlug[slug]?.DOWN || 0;

    if (sharesUp > 0 && pUp < 0.50) logger.log(`>>> COUNTERSIGNAL: Holding UP but pUp=${pUp.toFixed(4)}`);
    if (sharesDown > 0 && pDown < 0.50) logger.log(`>>> COUNTERSIGNAL: Holding DOWN but pDown=${pDown.toFixed(4)}`);

    // Detect rapid liquidity drain (early warning signal)
    // if (!state.liquidityHistory) state.liquidityHistory = [];

    // const currentLiquidity = {
    //   upDepth: upBook.asks?.reduce((sum, o) => sum + Number(o.size), 0) || 0,
    //   downDepth: downBook.asks?.reduce((sum, o) => sum + Number(o.size), 0) || 0,
    //   ts: Date.now()
    // };

    // state.liquidityHistory.push(currentLiquidity);
    // state.liquidityHistory = state.liquidityHistory.filter(l => Date.now() - l.ts < 30000);

    // if (state.liquidityHistory.length >= 3) {
    //   const oldest = state.liquidityHistory[0];
    //   const current = currentLiquidity;

    //   if (z > 0 && current.upDepth < oldest.upDepth * 0.5) {
    //     logger.log(`⚠️  LIQUIDITY ALERT: UP depth dropped ${((1 - current.upDepth/oldest.upDepth)*100).toFixed(0)}% in 30s`);
    //     logger.log(`   This suggests strong buying pressure - consider early entry`);
    //   }
    // }

    // ==============================================
    // NEW in v2.4.0: RECONCILE POSITIONS (if we have any)
    // ==============================================
    
    if (sharesUp > 5 || sharesDown > 5) {
      // Only reconcile if we have a significant position
      // This catches fill discrepancies before exit logic
      await reconcilePositions(state, logger);
    }

    // ==============================================
    // NEW in v2.4.0: CHECK EXIT CONDITIONS
    // ==============================================
    
    const exitCheck = shouldExitPosition(state, z, pUp, pDown, sharesUp, sharesDown, minsLeft, logger);
    
    if (exitCheck.shouldExit) {
      logger.log(`🚨 EXIT CONDITION MET - Attempting to close position`);
      
      const exitSuccess = await executeExit(asset, state, exitCheck, upBook, downBook, logger);
      
      if (exitSuccess) {
        state.weakSignalHistory = [];
        state.weakSignalCount = 0;
        logger.log(`✅ Position exited successfully - Stopping further trading this tick`);
        return; // Don't trade for rest of this tick
      } else {
        logger.warn(`⚠️  Exit attempt failed - Will retry next tick`);
        logger.warn(`⚠️  Blocking new entries to prevent adding to losing position`);
        return; // Don't add to position if exit failed
      }
    }

    if (minsLeft < 0.15) { // ~10 seconds
      logger.log(`🛑 ULTRA LATE: ${(minsLeft * 60).toFixed(0)}s left - no trading`);
      return;
    }

    // Log Snapshot
    logTickSnapshot({
      ts: Date.now(), symbol: asset.symbol, slug, minsLeft,
      startPrice, currentPrice, 
      sigmaPerMin: rawSigmaPerMin,
      drift,
      z, pUp, pDown, upAsk, downAsk,
      sharesUp, sharesDown,
    });

    // Note: entryZ storage moved to right before order placement (see below)

    // ==============================================
    // Time-Based Z-Threshold (SET ONCE)
    // ==============================================
    
    const absZ = Math.abs(z);
    let effectiveZMin;

    const isUS = isUSTradingHours();
    if (ENABLE_EARLY_TRADING && !isUS) {
      // Early trading enabled (non-US hours) - graduated thresholds
      if (minsLeft > 10) {
        effectiveZMin = 2.2 * regimeScalar; // Super early: very strict
      } else if (minsLeft > 8) {
        effectiveZMin = 1.9 * regimeScalar; // Kinda early: still strict
      } else if (minsLeft > 5) {
        effectiveZMin = 1.6 * regimeScalar; // Very early: strict
      } else if (minsLeft > 4) {
        effectiveZMin = 1.2 * regimeScalar;
      } else if (minsLeft > 3) {
        effectiveZMin = 1.1 * regimeScalar; // Mid early: moderate
      } else if (minsLeft > 2) {
        effectiveZMin = 0.9 * regimeScalar; // Getting close: normal
      } else {
        effectiveZMin = 0.7 * regimeScalar; // Late game: aggressive
      }
    } else {
      // US hours or early trading disabled
      if (minsLeft > 4) {
        logger.log(`Skip (${minsLeft.toFixed(1)} mins left): ${isUS ? 'US hours' : 'Early trading disabled'}`);
        return;
      } else if (minsLeft > 3) {
        effectiveZMin = 1.6 * regimeScalar; // Down from 1.8, strict for mid window
      } else if (minsLeft > 2) {
        effectiveZMin = 1.0 * regimeScalar; // Normal
      } else {
        effectiveZMin = (regimeScalar < 1.15) ? (0.7 * regimeScalar) : (1.0 * regimeScalar);
        logger.log(`Late game threshold: ${effectiveZMin.toFixed(2)} (regime ${regimeScalar < 1.15 ? 'CALM' : 'VOLATILE'})`);
      }
    }

    // ==============================================
    // RESTORED: Low-Vol Boost
    // In calm markets, signals are more reliable → trade more aggressively
    // ==============================================
    if (rawRegimeScalar < 1.1) {
      const LOW_VOL_BOOST = 0.85; // 15% easier in low vol
      const oldThreshold = effectiveZMin;
      effectiveZMin *= LOW_VOL_BOOST;

      logger.log(`[Low Vol Regime] Threshold reduced: ${oldThreshold.toFixed(2)} → ${effectiveZMin.toFixed(2)} (${((1-LOW_VOL_BOOST)*100).toFixed(0)}% easier)`);
    }

    // Single gating check
    if (absZ < effectiveZMin) {
      const evUp = upAsk ? pUp - upAsk : 0;
      const evDown = downAsk ? pDown - downAsk : 0;
      logger.log(`Skip: |z|=${absZ.toFixed(3)} < ${effectiveZMin.toFixed(2)} (${minsLeft.toFixed(1)}min left) | EV Up/Down: ${evUp.toFixed(3)}/${evDown.toFixed(3)}`);
      return;
    }

    // Signal decay detection
    if (state.zHistory.length >= 5) {
      const recentZ = state.zHistory.slice(-5);
      const zChange = recentZ[0].z - recentZ[recentZ.length - 1].z;
      const zDecayThreshold = minsLeft < 3 ? 0.25 : 0.4;
      
      // Only enforce if we have significant position
      const significantPosition = sharesUp > 100 || sharesDown > 100;

      // Check UP positions (z falling)
      if (significantPosition && sharesUp > 0 && zChange > zDecayThreshold) {
        logger.log(`⛔ RAPID SIGNAL DECAY (UP): z fell ${zChange.toFixed(2)} in 30s`);
        return;
      }
      
      // Check DOWN positions (z rising)
      if (significantPosition && sharesDown > 0 && zChange < -zDecayThreshold) {
        logger.log(`⛔ RAPID SIGNAL DECAY (DOWN): z rose ${Math.abs(zChange).toFixed(2)} in 30s`);
        return;
      }
    }

    // Method 1: Consecutive weak signals (fast response)
    if (!state.weakSignalCount) state.weakSignalCount = 0;

    if (sharesUp > 0 && z > 0 && z < 0.8) {
      state.weakSignalCount++;
      if (state.weakSignalCount > 3) {
        logger.log(`⛔ UP signal weak for ${state.weakSignalCount} ticks, stopping`);
        return;
      }
    } else if (sharesDown > 0 && z < 0 && z > -0.8) {
      state.weakSignalCount++;
      if (state.weakSignalCount > 3) {
        logger.log(`⛔ DOWN signal weak for ${state.weakSignalCount} ticks, stopping`);
        return;
      }
    } else {
      state.weakSignalCount = 0;
    }

    // Method 2: Ratio (robust against oscillation)
    if (!state.weakSignalHistory) state.weakSignalHistory = [];

    const isWeak = (sharesUp > 0 && z > 0 && z < 0.8) || (sharesDown > 0 && z < 0 && z > -0.8);
    state.weakSignalHistory.push(isWeak);
    if (state.weakSignalHistory.length > 10) {
      state.weakSignalHistory.shift();
    }

    const weakCount = state.weakSignalHistory.filter(x => x).length;
    if (weakCount >= 6) {
      logger.log(`⛔ Signal weak for ${weakCount}/10 ticks`);
      return;
    }

    // ==============================================
    // Large Signal Reversal Detector
    // ==============================================
    
    if (state.zHistory && state.zHistory.length >= 2) {
      const recent = state.zHistory.slice(-2);
      const oldZ = recent[0].z;
      const newZ = recent[recent.length - 1].z;
      
      const oldSign = Math.sign(oldZ);
      const newSign = Math.sign(newZ);
      
      // Signal flipped sign?
      if (oldSign !== newSign && oldSign !== 0 && newSign !== 0) {
        const reversalMagnitude = Math.abs(newZ - oldZ);
        
        // Large reversal (>1σ)?
        if (reversalMagnitude > 1.0) {
          logger.log(`⚠️  SIGNAL REVERSAL: z=${oldZ.toFixed(2)} → ${newZ.toFixed(2)}`);

          // Only block if we have position in OLD direction
          if ((oldSign > 0 && sharesUp > 0) || (oldSign < 0 && sharesDown > 0)) {
            logger.log(`⛔ Blocking: would add to losing ${oldSign > 0 ? 'UP' : 'DOWN'} position`);
            return;
          }

          logger.log(`✅ Allowing reversal trade in ${newSign > 0 ? 'UP' : 'DOWN'} direction`);
        }
      }
    }

    // 6) Decision Gating with Basis Risk Check
    const basisCheck = checkBasisRiskHybrid(
      currentPrice,
      startPrice,
      minsLeft,
      z,
      pUp,
      pDown,
      upAsk,
      downAsk,
      asset,
      logger,
      sharesUp,
      sharesDown
    );

    if (!basisCheck.safe) {
      logger.log(`Skipping trade: ${basisCheck.reason}`);
      return;
    }

    // 7) Trade Logic - Directional
    // EXPERIMENT: Keep track
    let zVelocity = 0;
    let cappedPredictedZ = z; // Default to current z
    if (state.zHistory.length >= 3) {
      const recent = state.zHistory.slice(-3);
      const timeSpan = (recent[2].ts - recent[0].ts) / 1000; // seconds
      const zChange = recent[2].z - recent[0].z;
      zVelocity = zChange / timeSpan;

      // Predict where z will be in 20 seconds
      const predictedZ = z + (zVelocity * 20);
      const maxPrediction = Math.abs(z) + 2.0; // Can't predict more than +2σ from current
      cappedPredictedZ = Math.sign(predictedZ) * Math.min(Math.abs(predictedZ), maxPrediction);

      logger.log(`💭 Prediction: z=${z.toFixed(2)}, velocity=${zVelocity.toFixed(3)}/s, predicted20s=${predictedZ.toFixed(2)}${predictedZ !== cappedPredictedZ ? ` (capped to ${cappedPredictedZ.toFixed(2)})` : ''}`);

      // Lower threshold if strong upward trajectory
      const minVelocity = 0.05; // Must be moving at least 0.05 z-score per second 
      if (Math.abs(cappedPredictedZ) > 2.0 &&
          Math.sign(cappedPredictedZ) === Math.sign(z) &&
          Math.abs(zVelocity) > minVelocity) {
        const originalZMin = effectiveZMin;
        effectiveZMin *= 0.85;
        logger.log(`📈 Strong trajectory detected: threshold ${originalZMin.toFixed(2)} → ${effectiveZMin.toFixed(2)}`);
      }
    }

    let candidates = [];
    if (z >= effectiveZMin && upAsk) {
      const evBuyUp = pUp - upAsk;
      logger.log(`Up ask=${upAsk.toFixed(3)}, pUp=${pUp}, EV buy Up=${evBuyUp.toFixed(4)}`);
      candidates.push({ side: "UP", ev: evBuyUp, ask: upAsk });
    } else {
      logger.log(`We don't buy Up here (z=${z.toFixed(3)} < ${effectiveZMin.toFixed(2)} or no ask).`);
    }

    if (z <= -effectiveZMin && downAsk) {
      const evBuyDown = pDown - downAsk;
      logger.log(`Down ask=${downAsk.toFixed(3)}, pDown=${pDown}, EV buy Down=${evBuyDown.toFixed(4)}`);
      candidates.push({ side: "DOWN", ev: evBuyDown, ask: downAsk });
    } else {
      logger.log(`We don't buy Down here (z=${z.toFixed(3)} > ${-effectiveZMin.toFixed(2)} or no ask).`);
    }

    // Dynamic edge requirements
    let dynamicMinEdge = (minsLeft > MINUTES_LEFT ? MIN_EDGE_EARLY : MIN_EDGE_LATE);
        
    // Low vol adjustment
    if (regimeScalar <= 1.1) {
      dynamicMinEdge = dynamicMinEdge * 0.6;
    }

    logger.log(`Min Edge Required: ${dynamicMinEdge.toFixed(4)} (Scalar: ${regimeScalar.toFixed(2)})`);
    
    candidates = candidates.filter(c => {
      let required = dynamicMinEdge;
      const cProb = c.side === "UP" ? pUp : pDown;
      
      if (cProb < 0.90) {
        required = Math.max(required, 0.03); // Down from 0.05
      }
      
      return c.ev > required;
    });

    if (z > 0 && z < 0.8 && sharesUp >= MAX_SHARES_WEAK_SIGNAL) {
      logger.log(`⚠️  Weak signal position limit: ${sharesUp} UP shares`);
      // Only allow DOWN (hedge)
      candidates = candidates.filter(c => c.side === 'DOWN');
      if (candidates.length === 0) return;
    }

    if (z < 0 && z > -0.8 && sharesDown >= MAX_SHARES_WEAK_SIGNAL) {
      logger.log(`⚠️  Weak signal position limit: ${sharesDown} DOWN shares`);
      // Only allow UP (hedge)
      candidates = candidates.filter(c => c.side === 'UP');
      if (candidates.length === 0) return;
    }

    // ============================================================
    // LATE GAME MODE (SIGNAL-AWARE)
    // ============================================================
    if (minsLeft < 2) {
      // ==============================================
      // Signal-Aware LATE_LAYER
      // Check if signal has reversed since entry
      // ==============================================
      
      if (state.entryZ !== null) {
        const entrySignal = state.entryZ;
        const currentSignal = z;

        const signalFlipped = Math.sign(entrySignal) !== Math.sign(currentSignal) 
                              && Math.sign(entrySignal) !== 0 
                              && Math.sign(currentSignal) !== 0;
        
        const reversalMagnitude = Math.abs(currentSignal - entrySignal);
        const largeReversal = reversalMagnitude > 1.0;

        if (signalFlipped && largeReversal) {
          logger.log(`⛔ LATE_LAYER BLOCKED: Signal reversed ${entrySignal.toFixed(2)} → ${currentSignal.toFixed(2)}`);
          return;
        }
      }

      if (minsLeft > 1.3 && state.zHistory && state.zHistory.length >= 3) {
        const recent30s = state.zHistory.filter(h => Date.now() - h.ts < 30000);
        
        if (recent30s.length >= 3) {
          const oldestZ = Math.abs(recent30s[0].z);
          const currentZ = Math.abs(z);
          const timeSpan = (Date.now() - recent30s[0].ts) / 1000;
          
          // Signal increased >50% in last 30 seconds?
          if (currentZ > oldestZ * 1.5 && oldestZ > 0.3) {
            const percentIncrease = ((currentZ - oldestZ) / oldestZ * 100);

            logger.log(`⚠️  SIGNAL SPIKE DETECTED`);
            logger.log(`   z: ${oldestZ.toFixed(2)} → ${currentZ.toFixed(2)} (+${percentIncrease.toFixed(0)}%) in ${timeSpan.toFixed(0)}s`);

            // Only block if we already have shares (prevents adding to spike)
            if (sharesUp + sharesDown > 0) {
              logger.log(`⛔ Skipping entry - spikes often reverse (mean reversion risk)`);
              return;
            }
            
            logger.log(`   Exception: No position yet, allowing cautious entry`);
          }
        }
      }

      // ==============================================
      // Original LATE_LAYER Logic Continues
      // ==============================================

      const expiresAt = Math.floor(Date.now() / 1000) + 15 * 60;
      const secsLeft = minsLeft * 60;
      let pReq = requiredLateProb(secsLeft);
      if (Math.abs(cappedPredictedZ) > 2.5 && Math.abs(zVelocity) > 0.05) {
        const originalPReq = pReq;
        pReq *= 0.95; // 5% easier (85% → 80.75%)
        logger.log(`📈 LATE_LAYER trajectory: pReq ${originalPReq.toFixed(3)} → ${pReq.toFixed(3)}`);
      }

      let lateSide = null, sideProb = 0, sideAsk = 0;

      if (pUp >= pReq && z > Math.max(0.7 * regimeScalar, 0.3)) {
        lateSide = "UP"; 
        sideProb = pUp; 
        sideAsk = upAsk || 0.99; 
      } else if (pDown >= pReq && z < -Math.max(0.7 * regimeScalar, 0.3)) {
        lateSide = "DOWN"; 
        sideProb = pDown; 
        sideAsk = downAsk || 0.99; 
      }

      // TODO: remove this if using ORACLE_SIGMA_MULTIPLE below
      if (minsLeft < 2 && minsLeft > 0.5 && sideAsk > 0.85) {
        // Require price to be at least 0.5 sigma away from strike
        const minDistanceRequired = 0.5 * rawSigmaPerMin * Math.sqrt(minsLeft);
        const actualDistance = Math.abs(currentPrice - startPrice);

        if (actualDistance < minDistanceRequired) {
          logger.log(`⛔ THIN MARGIN: $${actualDistance.toFixed(2)} < $${minDistanceRequired.toFixed(2)} (0.5σ at ${minsLeft.toFixed(1)}m)`);
          logger.log(`   Too close to strike for expensive late entry`);
          return;
        } else {
          logger.log(`✅ Margin OK: $${actualDistance.toFixed(2)} > $${minDistanceRequired.toFixed(2)} (${(actualDistance/minDistanceRequired).toFixed(1)}σ)`);
        }
      }

      if (lateSide) {
        // Time-graduated maximum prices for LATE_LAYER
        // Stricter caps as we get closer to expiry (higher gamma risk)
        let lateGameMax;
        if (minsLeft < 0.5) {
          lateGameMax = 0.85;  // <30s: very strict (need 85%+ win rate)
        } else if (minsLeft < 1.0) {
          lateGameMax = 0.88;  // <1min: strict (need 88%+ win rate)
        } else if (minsLeft < 1.5) {
          lateGameMax = 0.92;  // <90s: moderate (need 92%+ win rate)
        } else {
          lateGameMax = LATE_GAME_MAX_PRICE;  // <2min: 95¢ (need 95%+ win rate)
        }
        if (sideAsk > lateGameMax) {
          logger.log(`⛔ LATE GAME: ${(sideAsk*100).toFixed(0)}¢ > ${(lateGameMax*100).toFixed(0)}¢ max @ ${(minsLeft*60).toFixed(0)}s left`);
          logger.log(`   ${asset.symbol}: Too close to expiry for expensive bets`);
          return;
        }

        // TODO: consider enabling this
        // const ORACLE_SIGMA_MULTIPLE = 2.0;
        // const expectedMovement = ORACLE_SIGMA_MULTIPLE * rawSigmaPerMin * Math.sqrt(minsLeft);
        // const absDistanceFromStrike = Math.abs(currentPrice - startPrice);

        // if (absDistanceFromStrike < expectedMovement) {
        //   logger.log(`⛔ ORACLE RISK: Only $${absDistanceFromStrike.toFixed(2)} from strike`);
        //   logger.log(`   Need ${expectedMovement.toFixed(2)} buffer (${ORACLE_SIGMA_MULTIPLE}σ × $${rawSigmaPerMin.toFixed(2)}/min × √${minsLeft.toFixed(2)}min)`);
        //   logger.log(`   ${asset.symbol}: Too close for oracle deviation safety`);
        //   return;
        // }
        // logger.log(`✅ Oracle safe: $${absDistanceFromStrike.toFixed(2)} > ${expectedMovement.toFixed(2)} required buffer`);

        // 1. EXTREME SIGNAL - Kelly Criterion sizing
        let zHugeDynamic = Math.min(2.8, Z_HUGE * regimeScalar); // Capped at 2.8
        
        // RESTORED: Apply low-vol adjustment to extreme threshold
        if (rawRegimeScalar < 1.1) {
          const oldZHuge = zHugeDynamic;
          zHugeDynamic *= 0.95; // 5% easier in low vol
          logger.log(`[Low Vol] Extreme threshold: ${oldZHuge.toFixed(2)} → ${zHugeDynamic.toFixed(2)}`);
        }
        
        if (absZ >= zHugeDynamic && secsLeft <= LATE_GAME_EXTREME_SECS && 
            sideAsk <= LATE_GAME_MAX_PRICE && (sideProb - sideAsk) >= LATE_GAME_MIN_EV) {
          
          const limitPrice = Math.min(sideAsk, LATE_GAME_MAX_PRICE);
          const maxShares = MAX_SHARES_PER_MARKET[asset.symbol] || 500;
          
          // Use Kelly instead of fixed fraction
          const kellyShares = kellySize(sideProb, limitPrice, maxShares, ASSET_SPECIFIC_KELLY_FRACTION[asset.symbol] || 0.15);
          const bigSize = Math.max(10, Math.floor(kellyShares / 10) * 10); // Round to 10

          const capCheck = canPlaceOrder(state, slug, lateSide, bigSize, asset.symbol);
          const corrCheck = checkCorrelationRisk(state, asset.symbol, lateSide, bigSize);
          
          if (capCheck.ok && corrCheck.ok) {
            // BUG FIX #3: Store entryZ right before placing order
            if (state.entryZ === null) {
              state.entryZ = z;
              logger.log(`[Entry Signal] Stored z=${z.toFixed(2)} (EXTREME entry)`);
            }
            
            logger.log(`EXTREME: Buying ${bigSize} ${lateSide} @ ${limitPrice} (Kelly-sized, z=${absZ.toFixed(2)})`);
            
            try {
              const resp = await client.createAndPostOrder({
                tokenID: lateSide === "UP" ? upTokenId : downTokenId,
                price: limitPrice.toFixed(2), 
                side: Side.BUY, 
                size: bigSize, 
                expiration: String(expiresAt)
              }, { tickSize: "0.01", negRisk: false }, OrderType.GTD);
              
              if (resp && resp.orderID) {
                logOrderAttempt({
                  ts: Date.now(),
                  symbol: asset.symbol,
                  orderID: resp.orderID,
                  side: lateSide,
                  price: limitPrice,
                  size: bigSize,
                  type: "EXTREME"
                });

                const tokenId = lateSide === "UP" ? upTokenId : downTokenId;
                pendingOrders.set(resp.orderID, { 
                  asset: asset.symbol, 
                  side: lateSide, 
                  size: bigSize, 
                  tokenId: tokenId,
                  slug: slug,
                  timestamp: Date.now() 
                });

                addPosition(state, slug, lateSide, bigSize);
                state.sharesBoughtBySlug[slug] = (state.sharesBoughtBySlug[slug] || 0) + bigSize;
              }
            } catch (err) {
              logger.error(`EXTREME order failed: ${err.message}`);
            }
            
            return;
          } else {
            if (!capCheck.ok) {
              logger.log(`Skipping EXTREME; cap hit. (reason=${capCheck.reason})`);
            }
            if (!corrCheck.ok) {
              logger.log(`Skipping EXTREME; correlation risk too high: ${corrCheck.portfolioRisk.toFixed(1)} > ${corrCheck.limit}`);
            }
          }
        }

        // ==============================================
        // BUG FIX #2: Signal-Aware Position Cap
        // Fixed logic to properly detect sign flips before checking weakening
        // ==============================================
        
        const totalShares = sharesUp + sharesDown;
        if (totalShares >= 200) {
          if (state.entryZ !== null) {
            const entrySignalForCap = state.entryZ;
            const currentSignalForCap = z;  // Don't use Math.abs() - we need the sign!
            const entryStrength = Math.abs(entrySignalForCap);
            
            // CRITICAL: Check if signal flipped sign FIRST
            const sameSign = Math.sign(entrySignalForCap) === Math.sign(currentSignalForCap);
            if (!sameSign) {
              // Signal reversed - always block regardless of magnitude
              logger.log(`⛔ LATE_LAYER CAP: Signal reversed ${entrySignalForCap.toFixed(2)} → ${currentSignalForCap.toFixed(2)}`);
              return;
            }
            
            // 🆕 WHIPSAW DETECTION: Track weakest signal since entry
            // Initialize minZSinceEntry on first check
            if (state.minZSinceEntry === undefined || state.minZSinceEntry === null) {
              state.minZSinceEntry = entrySignalForCap;
            }
            
            // Update minimum if current signal is weaker (closer to zero)
            if (Math.abs(currentSignalForCap) < Math.abs(state.minZSinceEntry)) {
              state.minZSinceEntry = currentSignalForCap;
              logger.log(`📊 New weakest signal: ${currentSignalForCap.toFixed(2)} (entry: ${entrySignalForCap.toFixed(2)})`);
            }
            
            // Check if signal EVER dropped >30% (even if it recovered)
            const worstWeakening = (entryStrength - Math.abs(state.minZSinceEntry)) / entryStrength;
            
            if (worstWeakening > 0.3) {
              logger.log(`⛔ LATE_LAYER CAP: Signal dropped ${(worstWeakening*100).toFixed(0)}% since entry (WHIPSAW)`);
              logger.log(`   Entry: ${entrySignalForCap.toFixed(2)} → Lowest: ${state.minZSinceEntry.toFixed(2)} → Current: ${currentSignalForCap.toFixed(2)}`);
              return;
            }
            
            // Also check current weakening (your original check - keep this as backup)
            const currentStrength = Math.abs(currentSignalForCap);
            const currentWeakening = (entryStrength - currentStrength) / entryStrength;
            
            if (currentWeakening > 0.3) {
              logger.log(`⛔ LATE_LAYER CAP: Signal currently weak ${(currentWeakening*100).toFixed(0)}% (${totalShares} shares)`);
              return;
            }
          }
        }

        // 2. HYBRID LAYERED MODEL
        const LAYER_OFFSETS = [-0.02, -0.01, 0.0, +0.01];
        // const LAYER_MIN_EV = [0.006, 0.004, 0.002, 0.000];
        // const LAYER_MIN_EV = [0.003, 0.002, 0.001, 0.001];
        const LAYER_MIN_EV = [0.001, 0.002, 0.003, 0.005];

        let edgePenalty = 0;
        // if (asset.symbol === "SOL") {
        //   edgePenalty += 0.015;
        // }

        if (sideProb < 0.90) {
          edgePenalty += 0.015;
        }

        logger.log(
          `Late game hybrid: side=${lateSide}, prob=${sideProb.toFixed(4)}, ` +
          `ask=${sideAsk.toFixed(3)}, Penalty=${edgePenalty.toFixed(3)}`
        );

        for (let i = 0; i < LAYER_OFFSETS.length; i++) {
          let target = sideAsk + LAYER_OFFSETS[i];
          target = Math.max(0.01, Math.min(target, lateGameMax));

          // Only checked for early LATE_LAYER (>3 mins) - prevents expensive bets with lots of reversal time
          // Late game LATE_LAYER (<3 mins) has no max price cap - trust the proven signal
          // TODO: consider using this
          // const maxPrice = getMaxPriceForTime(minsLeft);
          // const isExtremeSignal = absZ > 2.2;
          // if (minsLeft > MINUTES_LEFT) {
          //   if (isExtremeSignal) {
          //     logger.log(`✅ Extreme signal (z=${absZ.toFixed(2)}) overrides max price at ${minsLeft.toFixed(1)}m`);
          //     // Allow trading, skip max price check
          //   } else if (target > maxPrice) {
          //     logger.log(`Layer ${i}: skip, price ${target.toFixed(2)} > ${maxPrice.toFixed(2)} max (${minsLeft.toFixed(1)}m left)`);
          //     continue;
          //   }
          // }

          const ev = sideProb - target;
          let minEv = LAYER_MIN_EV[i];

          if (regimeScalar < 1.2) {
            minEv *= 0.5;
          }
          const finalMinEv = minEv + edgePenalty;

          if (ev < finalMinEv) {
            logger.log(`Layer ${i}: skip @${target.toFixed(2)} (EV=${ev.toFixed(4)} < ${finalMinEv.toFixed(4)})`);
            continue;
          }

          let layerRiskBand = "medium";
          if (sideProb >= PROB_MIN_CORE && target >= PRICE_MIN_CORE) layerRiskBand = "core";
          else if (sideProb <= PROB_MAX_RISKY && target <= PRICE_MAX_RISKY) layerRiskBand = "risky";

          const layerSize = sizeForTrade(ev, minsLeft, { minEdgeOverride: 0.0, riskBand: layerRiskBand });
          if (layerSize <= 0) {
            logger.log(`Late layer ${i}: size <= 0, skipping.`);
            continue;
          }

          // Risk/reward check only applies for early LATE_LAYER entries (>3 mins)
          // Late game LATE_LAYER (<3 mins) has higher confidence - trust the strategy
          // This allows profitable 99¢ trades at 1-2 mins with 99%+ probability
          if (minsLeft > MINUTES_LEFT && !checkRiskReward(target, layerSize, sideProb, minsLeft, logger)) {
            logger.log(`Layer ${i}: skip, risk/reward too poor`);
            continue;
          }

          const capCheck = canPlaceOrder(state, slug, lateSide, layerSize, asset.symbol);
          const corrCheck = checkCorrelationRisk(state, asset.symbol, lateSide, layerSize);
          
          if (!capCheck.ok) {
            logger.log(`Layer ${i} skip; cap hit. (reason=${capCheck.reason})`);
            continue;
          }
          
          if (!corrCheck.ok) {
            logger.log(`Layer ${i} skip; correlation risk: ${corrCheck.portfolioRisk.toFixed(1)} > ${corrCheck.limit}`);
            continue;
          }
          
          if (capCheck.reason === "hedge_beyond_cap") {
            logger.log(`Layer ${i} allowed beyond cap (hedge).`);
          }

          const limitPrice = Number(target.toFixed(2));
          
          // BUG FIX #3: Store entryZ right before placing order
          if (state.entryZ === null) {
            state.entryZ = z;
            logger.log(`[Entry Signal] Stored z=${z.toFixed(2)} (LATE_LAYER entry)`);
          }
          
          logger.log(`Late layer ${i}: BUY ${lateSide} @ ${limitPrice}, size=${layerSize}, EV=${ev.toFixed(4)} (Req: ${finalMinEv.toFixed(4)})`);

          try {
            const resp = await client.createAndPostOrder({
              tokenID: lateSide === "UP" ? upTokenId : downTokenId,
              price: limitPrice.toFixed(2), 
              side: Side.BUY, 
              size: layerSize, 
              expiration: String(expiresAt)
            }, { tickSize: "0.01", negRisk: false }, OrderType.GTD);
            
            logger.log(`LATE LAYER ${i} RESP:`, resp);
            
            if (resp && resp.orderID) {
              logOrderAttempt({
                ts: Date.now(),
                symbol: asset.symbol,
                orderID: resp.orderID,
                side: lateSide,
                price: limitPrice,
                size: layerSize,
                type: "LATE_LAYER"
              });

              const tokenId = lateSide === "UP" ? upTokenId : downTokenId;
              pendingOrders.set(resp.orderID, { 
                asset: asset.symbol, 
                side: lateSide, 
                size: layerSize, 
                tokenId: tokenId,
                slug: slug,
                timestamp: Date.now() 
              });

              addPosition(state, slug, lateSide, layerSize);
              state.sharesBoughtBySlug[slug] = (state.sharesBoughtBySlug[slug] || 0) + layerSize;
            }
          } catch (err) {
            logger.error(`Error layer ${i}: ${err.message}`);
          }
        }
        
        return; // Exit after late game processing
      }
    }

    // --- Normal Entry ---
    if (!candidates.length) {
      logger.log("No trade candidates with positive EV.");
      return;
    }

    const best = candidates.reduce((a, b) => a.ev > b.ev ? a : b);
    
    let riskBand = "medium";
    const prob = best.side === "UP" ? pUp : pDown;
    if (prob >= PROB_MIN_CORE && best.ask >= PRICE_MIN_CORE) riskBand = "core";
    else if (prob <= PROB_MAX_RISKY && best.ask <= PRICE_MAX_RISKY) riskBand = "risky";

    const size = sizeForTrade(best.ev, minsLeft, { riskBand, minEdgeOverride: dynamicMinEdge });
    if (size <= 0) { 
      logger.log(`EV>0 but size=0`); 
      return; 
    }

    const capCheck = canPlaceOrder(state, slug, best.side, size, asset.symbol);
    const corrCheck = checkCorrelationRisk(state, asset.symbol, best.side, size);
    
    if (!capCheck.ok) { 
      logger.log(`Skip normal trade; cap hit. (reason=${capCheck.reason})`);
      return; 
    }
    
    if (!corrCheck.ok) {
      logger.log(`Skip normal trade; correlation risk: ${corrCheck.portfolioRisk.toFixed(1)} > ${corrCheck.limit}`);
      return;
    }

    // BUG FIX #3: Store entryZ right before placing order
    if (state.entryZ === null) {
      state.entryZ = z;
      logger.log(`[Entry Signal] Stored z=${z.toFixed(2)} (NORMAL entry)`);
    }

    let maxPrice = getMaxPriceForTime(minsLeft);
    if (absZ > 3.0) {
      maxPrice = 0.98;
      logger.log(`🚀 Z=${z.toFixed(2)} overrides time-based price cap. New max: 0.98`);
    }

    if (best.ask > maxPrice) {
      logger.log(`🛑 Price ${best.ask.toFixed(2)} > ${maxPrice.toFixed(2)} max (${minsLeft.toFixed(1)}m left)`);
      return;
    }

    if (!checkRiskReward(best.ask, size, prob, minsLeft, logger)) {
      return;
    }

    if (minsLeft < 1.0) {
      if (prob < 0.90) {
        logger.log(`🛑 NORMAL order too late with low conviction: ${(prob * 100).toFixed(1)}% at ${(minsLeft * 60).toFixed(0)}s`);
        return;
      }

      const profitMargin = 1.0 - best.ask;
      if (profitMargin < 0.20) {
        logger.log(`🛑 NORMAL order: margin too thin ($${profitMargin.toFixed(2)}) for ${(prob * 100).toFixed(1)}% conviction`);
        return;
      }
    }

    logger.log(`SIGNAL: BUY ${best.side} @ ${best.ask.toFixed(2)} (Size: ${size})`);

    try {
      const resp = await client.createAndPostOrder({
        tokenID: best.side === "UP" ? upTokenId : downTokenId,
        price: best.ask.toFixed(2), 
        side: Side.BUY, 
        size, 
        expiration: String(Math.floor(Date.now()/1000)+900)
      }, { tickSize: "0.01", negRisk: false }, OrderType.GTD);
      
      logger.log(`ORDER RESP:`, resp);
      
      if (resp && resp.orderID) {
        logOrderAttempt({
          ts: Date.now(),
          symbol: asset.symbol,
          orderID: resp.orderID,
          side: best.side,
          price: best.ask,
          size: size,
          type: "NORMAL"
        });

        const tokenId = best.side === "UP" ? upTokenId : downTokenId;
        pendingOrders.set(resp.orderID, { 
          asset: asset.symbol, 
          side: best.side, 
          size, 
          tokenId: tokenId,
          slug: slug,
          timestamp: Date.now() 
        });

        addPosition(state, slug, best.side, size);
        state.sharesBoughtBySlug[slug] = (state.sharesBoughtBySlug[slug] || 0) + size;
      }
    } catch (err) {
      logger.error(`Normal order failed: ${err.message}`);
    }

  } catch (err) {
    logger.error("Exec failed:", err.message, err.stack);
  } finally {
    executionLock[asset.symbol] = false;
    logger.flush();
  }
}

async function getBatchPythPrices(pythIds) {
  try {
    const uniqueIds = [...new Set(pythIds)];
    const params = new URLSearchParams();
    uniqueIds.forEach((id) => params.append("ids[]", id));
    const res = await fetch(`https://hermes.pyth.network/api/latest_price_feeds?${params.toString()}`);
    if (!res.ok) return {};
    const data = await res.json();
    const map = {};
    if (Array.isArray(data)) {
      data.forEach(item => {
        if (!item.price) return;
        const raw = Number(item.price.price);
        const expo = Number(item.price.expo);
        if (!Number.isFinite(raw)) return;
        let key = item.id;
        if (!key.startsWith("0x")) key = "0x" + key;
        map[key] = { price: raw * Math.pow(10, expo) };
      });
    }
    return map;
  } catch (e) { 
    console.error("Pyth Batch Error", e.message); 
    return {}; 
  }
}

async function execAll() {
  console.log(`\n=== TICK ${new Date().toISOString()} ===`);
  
  try {
    const pythPrices = await getBatchPythPrices(ASSETS.map(a => a.pythId));
    
    await Promise.all(ASSETS.map(asset => {
      const priceData = pythPrices[asset.pythId];
      if (!priceData) {
        console.log(`[${asset.symbol}] No price data`);
        return Promise.resolve();
      }
      VolatilityManager.updatePriceHistory(asset.symbol, priceData.price);
      return execForAsset(asset, priceData);
    }));
  } catch (err) {
    console.error("execAll error:", err.message, err.stack);
  }
  
  console.log("=== TICK END ===");
}

// === STARTUP & SCHEDULER ===
(async () => {
  console.log("Initializing Bot v2.4.1...");
  console.log("🚨 EXIT MECHANISM ENABLED");
  console.log(`   Reversal threshold: ${EXIT_REVERSAL_THRESHOLD}σ (after sign flip)`);
  console.log(`   Emergency probability: ${(EXIT_PROBABILITY_THRESHOLD*100).toFixed(0)}%`);
  console.log(`   Min position size: ${EXIT_MIN_POSITION_SIZE} shares`);
  console.log("");

  try {
    // 1. Warm up volatility with historical data
    const symbols = ASSETS.map(a => a.symbol);
    await VolatilityManager.backfillHistory(symbols);

    console.log("✅ Backfill complete");

    // 2. Start the loop
    console.log(`Starting Cron (every ${interval}s)...`);
    cron.schedule(`*/${interval} * * * * *`, () => {
      execAll().catch(err => {
        console.error("Cron execution error:", err.message, err.stack);
      });
    });
    
    console.log("🚀 Bot v2.4.1 running with active position management!");
  } catch (err) {
    console.error("FATAL: Startup failed:", err.message, err.stack);
    process.exit(1);
  }
})();
