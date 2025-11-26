// Version 2.3 - Signal-Aware Trading with Reversal Detection
// Key Changes from 2.1:
// - Added entry z-score storage for signal reversal detection
// - Signal-aware LATE_LAYER: blocks if signal has reversed >1.5σ
// - Large reversal detector: exits all trading after >1.5σ reversal
// - Fixed regime scalar application to all time-based thresholds
// - Consolidated threshold logic (set once, no duplicates)
// - Lowered 2-3 min threshold from 1.2 to 0.9 (sweet spot window)
// - Added drift clamping to prevent extreme values
// - Removed duplicate reversal checks

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
  BTC: 5,   // 0.05% (~$45 at $90k)
  ETH: 7,   // 0.07%
  SOL: 7,   // 0.07%
  XRP: 7
};

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

// Time / edge thresholds
const MINUTES_LEFT = 3;
const MIN_EDGE_EARLY = 0.05;
const MIN_EDGE_LATE  = 0.03;

// EARLY TRADING CONFIG (5-15 mins left)
const ENABLE_EARLY_TRADING = true; // Toggle this to enable/disable early trading
const MAX_SHARES_WEAK_SIGNAL = 70;

// Regime scalar bounds (prevent extreme adjustments)
const REGIME_SCALAR_MIN = 0.7; // Don't make thresholds too high in low vol
const REGIME_SCALAR_MAX = 1.4; // Don't make thresholds too low in high vol

// Limits for dynamicZMax (time-based momentum filter)
const Z_MAX_FAR_MINUTES = 6;
const Z_MAX_NEAR_MINUTES = 3;
const Z_MAX_FAR = 2.5;
const Z_MAX_NEAR = 1.7;

// Extreme late-game constants
const Z_HUGE = 2.8; // Requires ~99.7% probability
const LATE_GAME_EXTREME_SECS = 8;
const LATE_GAME_MIN_EV = 0.01;
const LATE_GAME_MAX_PRICE = 0.98;

// Early trading size reduction (>5 mins left)
const EARLY_TRADE_SIZE_MULTIPLIER = 0.4; // 40% of normal size for very early trades

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
  
  // NEW: Clamp drift to ±0.1% of price per minute (prevents extreme values)
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
  const minSafeDist = BASIS_BUFFER_BPS[asset.symbol] || 10;
  
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
  
  return { safe: true, reason: "No clear signal" };
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

// FIXED: Time decay now INCREASES volatility near expiry (gamma risk)
function getTimeDecayFactor(minsLeft) {
  if (minsLeft >= 1) return 1.0;
  
  const secsLeft = minsLeft * 60;
  if (secsLeft >= 30) return 1.0;
  
  // Increase vol by up to 40% in final 30 seconds
  const t = Math.max(0, Math.min(1, (30 - secsLeft) / 30));
  return 1.0 + t * 0.4; // 1.0 -> 1.4
}

// Time-based momentum filter
function dynamicZMax(minsLeft) {
  if (minsLeft >= Z_MAX_FAR_MINUTES) return Z_MAX_FAR;
  if (minsLeft <= Z_MAX_NEAR_MINUTES) return Z_MAX_NEAR;
  const t = (Z_MAX_FAR_MINUTES - minsLeft) / (Z_MAX_FAR_MINUTES - Z_MAX_NEAR_MINUTES);
  return Z_MAX_FAR - t * (Z_MAX_FAR - Z_MAX_NEAR);
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
  return totalMins >= 12 * 60 + 45 && totalMins < 19 * 60 + 45;
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
  
  // Apply early trading size reduction if >5 mins left
  if (minsLeft > 5) {
    size = Math.round((size * EARLY_TRADE_SIZE_MULTIPLIER) / 10) * 10;
  }
  
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

function ensureState(asset) {
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
      entryZ: null,  // NEW: Store entry z-score for reversal detection
      weakSignalCount: 0,
      weakSignalHistory: []
    };
    console.log(`[${asset.symbol}] Reset state for ${slug}`);
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
    const state = ensureState(asset);
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
    const z = (currentPrice - startPrice - drift * minsLeft) / sigmaT;
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

    const sharesUp = state.sideSharesBySlug[slug]?.UP || 0;
    const sharesDown = state.sideSharesBySlug[slug]?.DOWN || 0;

    if (sharesUp > 0 && pUp < 0.50) logger.log(`>>> COUNTERSIGNAL: Holding UP but pUp=${pUp.toFixed(4)}`);
    if (sharesDown > 0 && pDown < 0.50) logger.log(`>>> COUNTERSIGNAL: Holding DOWN but pDown=${pDown.toFixed(4)}`);

    if (z > 0 && z < 0.8 && sharesUp >= MAX_SHARES_WEAK_SIGNAL) {
      logger.log(`⛔ Weak signal position limit: ${sharesUp} shares with z=${z.toFixed(2)}`);
      return;
    }

    if (z < 0 && z > -0.8 && sharesDown >= MAX_SHARES_WEAK_SIGNAL) {
      logger.log(`⛔ Weak signal position limit: ${sharesDown} shares with z=${z.toFixed(2)}`);
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

    // ==============================================
    // NEW: Store Entry Z-Score for Signal Reversal Detection
    // ==============================================
    
    if (state.entryZ === null && (sharesUp > 0 || sharesDown > 0)) {
      state.entryZ = z;
      logger.log(`[Entry Signal] Stored z=${z.toFixed(2)}`);
    }

    // ==============================================
    // Time-Based Z-Threshold (SET ONCE)
    // ==============================================
    
    const absZ = Math.abs(z);
    let effectiveZMin;

    if (ENABLE_EARLY_TRADING && !isUSTradingHours()) {
      // Early trading enabled (non-US hours) - graduated thresholds
      if (minsLeft > 8) {
        effectiveZMin = 1.9 * regimeScalar; // Super early: very strict
      } else if (minsLeft > 5) {
        effectiveZMin = 1.6 * regimeScalar; // Very early: strict
      } else if (minsLeft > 3) {
        effectiveZMin = 1.3 * regimeScalar; // Mid early: moderate
      } else if (minsLeft > 2) {
        effectiveZMin = 0.9 * regimeScalar; // Getting close: normal (LOWERED from 1.2)
      } else {
        effectiveZMin = 0.7 * regimeScalar; // Late game: aggressive
      }
    } else {
      // US hours or early trading disabled
      if (minsLeft > 5) {
        logger.log(`Skip (${minsLeft.toFixed(1)} mins left): ${isUSTradingHours() ? 'US hours' : 'Early trading disabled'}`);
        return;
      } else if (minsLeft > 3) {
        effectiveZMin = 1.8 * regimeScalar; // Strict for mid window
      } else if (minsLeft > 2) {
        effectiveZMin = 0.9 * regimeScalar; // Normal (LOWERED from 1.0)
      } else {
        effectiveZMin = 0.7 * regimeScalar; // Late
      }
    }

    // Apply low-vol adjustment
    if (rawRegimeScalar < 1.1 && minsLeft > 2) {
      effectiveZMin *= 0.85;
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
    // NEW: Large Signal Reversal Detector
    // ==============================================
    
    if (state.zHistory && state.zHistory.length >= 4) {
      const recent = state.zHistory.slice(-4);
      const oldZ = recent[0].z;
      const newZ = recent[recent.length - 1].z;
      
      const oldSign = Math.sign(oldZ);
      const newSign = Math.sign(newZ);
      
      // Signal flipped sign?
      if (oldSign !== newSign && oldSign !== 0 && newSign !== 0) {
        const reversalMagnitude = Math.abs(newZ - oldZ);
        
        // Large reversal (>1.5σ)?
        if (reversalMagnitude > 1.5) {
          logger.log(`⚠️  SIGNAL REVERSAL: z=${oldZ.toFixed(2)} → ${newZ.toFixed(2)} (Δ=${reversalMagnitude.toFixed(2)}σ)`);
          logger.log(`⛔ EXIT: Large signal reversal, stopping all trading`);
          return;
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
    let candidates = [];

    if (z >= effectiveZMin && upAsk) {
      const evBuyUp = pUp - upAsk;
      logger.log(`Up ask=${upAsk.toFixed(3)}, EV buy Up=${evBuyUp.toFixed(4)}`);
      candidates.push({ side: "UP", ev: evBuyUp, ask: upAsk });
    } else {
      logger.log(`We don't buy Up here (z=${z.toFixed(3)} < ${effectiveZMin.toFixed(2)} or no ask).`);
    }

    if (z <= -effectiveZMin && downAsk) {
      const evBuyDown = pDown - downAsk;
      logger.log(`Down ask=${downAsk.toFixed(3)}, EV buy Down=${evBuyDown.toFixed(4)}`);
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
    
    // Asset-specific adjustments
    if (asset.symbol === "SOL") {
      dynamicMinEdge += 0.02;
    }

    logger.log(`Min Edge Required: ${dynamicMinEdge.toFixed(4)} (Scalar: ${regimeScalar.toFixed(2)})`);
    
    candidates = candidates.filter(c => {
      let required = dynamicMinEdge;
      const cProb = c.side === "UP" ? pUp : pDown;
      
      if (cProb < 0.90) {
        required = Math.max(required, 0.05);
      }
      
      return c.ev > required;
    });

    // ============================================================
    // LATE GAME MODE (SIGNAL-AWARE)
    // ============================================================
    const zMaxTimeBased = dynamicZMax(minsLeft);
    
    if (absZ > zMaxTimeBased || minsLeft < 2) {
      // ==============================================
      // NEW: Signal-Aware LATE_LAYER
      // Check if signal has reversed since entry
      // ==============================================
      
      const entrySignal = state.entryZ || z;
      const currentSignal = z;

      const signalFlipped = Math.sign(entrySignal) !== Math.sign(currentSignal) 
                            && Math.sign(entrySignal) !== 0 
                            && Math.sign(currentSignal) !== 0;

      const reversalMagnitude = Math.abs(currentSignal - entrySignal);
      const largeReversal = reversalMagnitude > 1.5;

      if (signalFlipped && largeReversal) {
        logger.log(`⛔ LATE_LAYER BLOCKED: Signal reversed ${entrySignal.toFixed(2)} → ${currentSignal.toFixed(2)} (Δ=${reversalMagnitude.toFixed(2)}σ)`);
        return;
      }

      // ==============================================
      // Original LATE_LAYER Logic Continues
      // ==============================================

      const expiresAt = Math.floor(Date.now() / 1000) + 15 * 60;
      const secsLeft = minsLeft * 60;
      const pReq = requiredLateProb(secsLeft);

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

      if (lateSide) {
        // 1. EXTREME SIGNAL - Kelly Criterion sizing
        const zHugeDynamic = Math.min(2.8, Z_HUGE * regimeScalar); // Capped at 2.8
        
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

                pendingOrders.set(resp.orderID, { asset: asset.symbol, side: lateSide, size: bigSize, timestamp: Date.now() });

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

        // 2. HYBRID LAYERED MODEL
        const LAYER_OFFSETS = [-0.02, -0.01, 0.0, +0.01];
        const LAYER_MIN_EV = [0.006, 0.004, 0.002, 0.000];

        let edgePenalty = 0;
        if (asset.symbol === "SOL") {
          edgePenalty += 0.015;
        }

        if (sideProb < 0.90) {
          edgePenalty += 0.03;
        }

        logger.log(
          `Late game hybrid: side=${lateSide}, prob=${sideProb.toFixed(4)}, ` +
          `ask=${sideAsk.toFixed(3)}, Penalty=${edgePenalty.toFixed(3)}`
        );

        for (let i = 0; i < LAYER_OFFSETS.length; i++) {
          let target = sideAsk + LAYER_OFFSETS[i];
          target = Math.max(0.01, Math.min(target, 0.99));

          const ev = sideProb - target;
          let minEv = LAYER_MIN_EV[i];

          if (regimeScalar < 1.2) {
            minEv *= 0.6;
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

              pendingOrders.set(resp.orderID, { asset: asset.symbol, side: lateSide, size: layerSize, timestamp: Date.now() });

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

    const size = sizeForTrade(best.ev, minsLeft, { riskBand });
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

    const sizeInfo = minsLeft > 5 ? ` (Early trade: ${(size / EARLY_TRADE_SIZE_MULTIPLIER).toFixed(0)} → ${size})` : '';
    logger.log(`SIGNAL: BUY ${best.side} @ ${best.ask.toFixed(2)} (Size: ${size}${sizeInfo})`);
    
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

        pendingOrders.set(resp.orderID, { asset: asset.symbol, side: best.side, size, timestamp: Date.now() });

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
  console.log("Initializing Bot v2.3...");

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
    
    console.log("🚀 Bot v2.3 running!");
  } catch (err) {
    console.error("FATAL: Startup failed:", err.message, err.stack);
    process.exit(1);
  }
})();
