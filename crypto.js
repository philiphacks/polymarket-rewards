// Version 1.3 (Verbose Logging Restored)

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

const MAX_SHARES_PER_MARKET = { BTC: 600, ETH: 300, SOL: 300, XRP: 200 };

// Time / z thresholds
const MINUTES_LEFT = 3;
const MIN_EDGE_EARLY = 0.05;
const MIN_EDGE_LATE  = 0.03;

// Base z-thresholds (Will be scaled by Regime Scalar)
const Z_MIN_EARLY = 1.0;
const Z_MIN_LATE  = 0.7;

// Limits for dynamicZMax (time-based)
const Z_MAX_FAR_MINUTES = 6;
const Z_MAX_NEAR_MINUTES = 3;
const Z_MAX_FAR = 2.5;
const Z_MAX_NEAR = 1.7;

// Extreme late-game constants
const Z_HUGE = 4.0; // Will also be scaled by Regime Scalar
const LATE_GAME_EXTREME_SECS = 8;
const LATE_GAME_MAX_FRACTION = 0.3;
const LATE_GAME_MIN_EV = 0.01;
const LATE_GAME_MAX_PRICE = 0.98;

// Risk bands
const PRICE_MIN_CORE = 0.90; const PROB_MIN_CORE  = 0.97;
const PRICE_MAX_RISKY = 0.90; const PROB_MAX_RISKY  = 0.95;
const MAX_REL_DIFF = 0.05;

// CLOB
const CLOB_HOST = "https://clob.polymarket.com";
const CHAIN_ID = 137;
const SIGNATURE_TYPE = 1;
const FUNDER = "0xA69b1867a00c87928b5A1f6B1c2e9aC2246bD844";

const signer = new Wallet(process.env.PRIVATE_KEY);
const creds = await new ClobClient(CLOB_HOST, CHAIN_ID, signer).createOrDeriveApiKey();
console.log("Address:", await signer.getAddress());
const client = new ClobClient(CLOB_HOST, CHAIN_ID, signer, creds, SIGNATURE_TYPE, FUNDER);

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

function normCdf(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp(-0.5 * z * z);
  let p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  if (z > 0) p = 1 - p;
  return p;
}

// This handles TIME based Z-Max (for the "Don't trade against momentum early" logic)
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

// Approximate US "slam" window
function isInSlamWindow(date = new Date()) {
  const totalMins = date.getUTCHours() * 60 + date.getUTCMinutes();
  return totalMins >= 14 * 60 + 45 && totalMins < 15 * 60;
}

// Logging (File IO)
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
  return Math.min(size, ABS_MAX);
}

// New Helper: replaces effectiveSigmaPerMin from V1.0
function getTimeDecayFactor(minsLeft) {
  if (minsLeft >= 1) return 1.0;
  const secsLeft = minsLeft * 60;
  if (secsLeft >= 30) return 1.0;
  const t = Math.max(0, Math.min(1, (30 - secsLeft) / 30));
  return 1 - t * (1 - 0.6);
}

// ---------- STATE & EXECUTION ----------
const stateBySymbol = {};

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
    };
    console.log(`[${asset.symbol}] Reset state for ${slug}`);
  }
  return stateBySymbol[asset.symbol];
}

async function execForAsset(asset, priceData) {
  const logger = createScopedLogger(asset.symbol);

  try {
    const state = ensureState(asset);
    if (state.resetting) return;
    const { slug, cryptoPriceUrl, gammaUrl } = state;

    logger.log(`\n\n===== ${asset.symbol} | slug=${slug} =====`);

    // 1) Gamma Meta
    if (!state.marketMeta || state.marketMeta.slug !== slug) {
      const gammaRes = await fetch(gammaUrl);
      if (!gammaRes.ok) { logger.log(`Gamma failed: ${gammaRes.status}`); return; }
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
      stateBySymbol[asset.symbol] = null; // Force clean reset
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
      if (cpRes.status === 429) { await sleep(3000); return; }
      if (!cpRes.ok) return;
      const cp = await cpRes.json();
      if (Number(cp.openPrice) > 0) {
        state.cpData = { ...cp, _cachedAt: Date.now() };
        startPrice = Number(cp.openPrice);
        logger.log(`Start Price cached: ${startPrice}`);
      } else return;
    }

    // 3) Current Price & Sanity
    const currentPrice = priceData.price;
    logger.log(`Open $${startPrice.toFixed(4)} | Curr $${currentPrice.toFixed(4)}`);

    if (Math.abs(currentPrice - startPrice) / startPrice > MAX_REL_DIFF) {
      logger.log(`Price sanity FAILED. Skipping.`);
      return;
    }

    // 4) Volatility & Math (Merged Logic)
    let rawSigmaPerMin = VolatilityManager.getRealizedVolatility(asset.symbol, currentPrice);
    const effectiveSigma = rawSigmaPerMin * getTimeDecayFactor(minsLeft);
    const volRatio = VolatilityManager.getVolRegimeRatio(asset.symbol, rawSigmaPerMin);
    const regimeScalar = Math.sqrt(volRatio);

    const sigmaT = effectiveSigma * Math.sqrt(minsLeft);
    const z = (currentPrice - startPrice) / sigmaT;
    const pUp = normCdf(z);
    const pDown = 1 - pUp;

    logger.log(
      `σ_raw: $${rawSigmaPerMin.toFixed(4)} (Ratio: ${volRatio.toFixed(2)}x) | ` +
      `Scalar: ${regimeScalar.toFixed(2)}x | z: ${z.toFixed(3)}`
    );

    // 5) Order Books
    const [upTokenId, downTokenId] = tokenIds;
    const [upBook, downBook] = await Promise.all([client.getOrderBook(upTokenId), client.getOrderBook(downTokenId)]);
    const { bestAsk: upAsk } = getBestBidAsk(upBook);
    const { bestAsk: downAsk } = getBestBidAsk(downBook);

    // --- Verbose Logs ---
    const mid = (upAsk && downAsk) ? (upAsk + downAsk) / 2 : (upAsk || downAsk);
    logger.log(`Up ask / Down ask: ${upAsk?.toFixed(3) ?? 'n/a'} / ${downAsk?.toFixed(3) ?? 'n/a'}, mid≈${mid?.toFixed(3) ?? 'n/a'}`);

    if (!upAsk && !downAsk) { logger.log("No asks."); return; }

    const existingSide = getExistingSide(state, slug);
    logger.log(`Existing net side: ${existingSide || "FLAT"}`);

    const sharesUp = state.sideSharesBySlug[slug]?.UP || 0;
    const sharesDown = state.sideSharesBySlug[slug]?.DOWN || 0;

    if (sharesUp > 0 && pUp < 0.50) logger.log(`>>> COUNTERSIGNAL: Holding UP but pUp=${pUp.toFixed(4)}`);
    if (sharesDown > 0 && pDown < 0.50) logger.log(`>>> COUNTERSIGNAL: Holding DOWN but pDown=${pDown.toFixed(4)}`);

    // Log Snapshot
    logTickSnapshot({
      ts: Date.now(), symbol: asset.symbol, slug, minsLeft,
      startPrice, currentPrice, 
      sigmaPerMin: rawSigmaPerMin,
      z, pUp, pDown, upAsk, downAsk,
      sharesUp, sharesDown,
    });

    // 6) Decision Gating
    const zMaxTimeBased = dynamicZMax(minsLeft);
    const absZ = Math.abs(z);

    // --- STEP 3: DYNAMIC Z-THRESHOLD SCALING ---
    let zMinEarlyDynamic = Z_MIN_EARLY * regimeScalar;
    let zMinLateDynamic  = Z_MIN_LATE * regimeScalar;
    let zHugeDynamic     = Z_HUGE * regimeScalar;

    // LOW VOLATILITY ADJUSTMENT:
    // If the regime is "calm" (scalar < 1.2), mean reversion is safer.
    // We lower the Z-barriers by 15% to get active in the chop.
    if (regimeScalar < 1.2) {
      const LOW_VOL_DISCOUNT = 0.85; // Reduce req by 15%
      zMinEarlyDynamic *= LOW_VOL_DISCOUNT;
      zMinLateDynamic  *= LOW_VOL_DISCOUNT;
      // We keep Z_HUGE mostly intact or reduce slightly, as "Extreme" still needs to be extreme
      zHugeDynamic     *= 0.95; 
      
      logger.log(`[Low Vol Regime] Reducing Z-thresholds by 15%. New Early/Late: ${zMinEarlyDynamic.toFixed(2)} / ${zMinLateDynamic.toFixed(2)}`);
    }
    // -------------------------------------------

    // Gating Log
    if (
      minsLeft > 5 ||
      (minsLeft > MINUTES_LEFT && minsLeft <= 5 && absZ < zHugeDynamic) ||
      (minsLeft <= MINUTES_LEFT && absZ < zMinLateDynamic)
    ) {
      const evUp = upAsk ? pUp - upAsk : 0;
      const evDown = downAsk ? pDown - downAsk : 0;
      logger.log(`Skip: |z|=${absZ.toFixed(3)} < Req (Huge=${zHugeDynamic.toFixed(2)}, Min=${zMinLateDynamic.toFixed(2)}) | EV Up/Down: ${evUp.toFixed(3)}/${evDown.toFixed(3)}`);
      return;
    }

    // 7) Trade Logic
    const directionalZMin = minsLeft > MINUTES_LEFT ? zMinEarlyDynamic : zMinLateDynamic;
    let candidates = [];

    // Detailed Directional Logging
    if (z >= directionalZMin && upAsk) {
      const evBuyUp = pUp - upAsk;
      logger.log(`Up ask=${upAsk.toFixed(3)}, EV buy Up=${evBuyUp.toFixed(4)}`);
      candidates.push({ side: "UP", ev: evBuyUp, ask: upAsk });
    } else {
      logger.log(`We don't buy Up here (z=${z.toFixed(3)} too small or no ask).`);
    }

    if (z <= -directionalZMin && downAsk) {
      const evBuyDown = pDown - downAsk;
      logger.log(`Down ask=${downAsk.toFixed(3)}, EV buy Down=${evBuyDown.toFixed(4)}`);
      candidates.push({ side: "DOWN", ev: evBuyDown, ask: downAsk });
    } else {
      logger.log(`We don't buy Down here (z=${z.toFixed(3)} too small or no ask).`);
    }

    let dynamicMinEdge = (minsLeft > MINUTES_LEFT ? MIN_EDGE_EARLY : MIN_EDGE_LATE);
        
    // If market is quiet (scalar near 1.0), reduce required edge by up to 40%
    if (regimeScalar <= 1.1) {
      dynamicMinEdge = dynamicMinEdge * 0.6;
      // e.g. 0.03 becomes 0.018 (1.8% edge)
    }
    // OPTIMIZATION: Demand higher edge for "risky" assets or lower prob trades
    if (asset.symbol === "SOL") {
      dynamicMinEdge += 0.02; // Require +2% extra edge for SOL
    }

    logger.log(`Min Edge Required: ${dynamicMinEdge.toFixed(4)} (Scalar: ${regimeScalar.toFixed(2)})`);
    candidates = candidates.filter(c => {
      let required = dynamicMinEdge;
      
      // Determine probability for this candidate
      const cProb = c.side === "UP" ? pUp : pDown;
      
      // If signal is weak (<90%), demand 5% edge
      if (cProb < 0.90) {
        required = Math.max(required, 0.05);
      }
      
      return c.ev > required;
    });

    // ============================================================
    // LATE GAME MODE
    // ============================================================
    if (absZ > zMaxTimeBased || (minsLeft < 2 && minsLeft > 0.001)) {
      const expiresAt = Math.floor(Date.now() / 1000) + 15 * 60;
      const secsLeft = minsLeft * 60;
      const pReq = requiredLateProb(secsLeft);

      let lateSide = null, sideProb = 0, sideAsk = 0;

      if (pUp >= pReq && z > zMinLateDynamic) { lateSide = "UP"; sideProb = pUp; sideAsk = upAsk || 0.99; }
      else if (pDown >= pReq && z < -zMinLateDynamic) { lateSide = "DOWN"; sideProb = pDown; sideAsk = downAsk || 0.99; }

      if (lateSide) {
        // 1. EXTREME SIGNAL
        if (absZ >= zHugeDynamic && secsLeft <= LATE_GAME_EXTREME_SECS && sideAsk <= LATE_GAME_MAX_PRICE && (sideProb - sideAsk) >= LATE_GAME_MIN_EV) {
          const limitPrice = Math.min(sideAsk, LATE_GAME_MAX_PRICE);
          const maxShares = MAX_SHARES_PER_MARKET[asset.symbol] || 500;
          const bigSize = Math.floor(maxShares * LATE_GAME_MAX_FRACTION);

          const capCheck = canPlaceOrder(state, slug, lateSide, bigSize, asset.symbol);
          if (capCheck.ok) {
            logger.log(`EXTREME: Buying ${bigSize} ${lateSide} @ ${limitPrice}`);
            const resp = await client.createAndPostOrder({
              tokenID: lateSide === "UP" ? upTokenId : downTokenId,
              price: limitPrice.toFixed(2), side: Side.BUY, size: bigSize, expiration: String(expiresAt)
            }, { tickSize: "0.01", negRisk: false }, OrderType.GTD);
            if (resp && resp.orderID) {
              logOrderAttempt({
                ts: Date.now(),
                symbol: asset.symbol,
                orderID: resp.orderID,
                side: lateSide,
                price: limitPrice,
                size: bigSize,
                type: "EXTREME" // or "EXTREME" or "LATE_LAYER"
              });
            }

            addPosition(state, slug, lateSide, bigSize);
            state.sharesBoughtBySlug[slug] = (state.sharesBoughtBySlug[slug] || 0) + bigSize;
            return; 
          } else {
             logger.log(
              `Skipping EXTREME; cap hit. (reason=${capCheck.reason}, ` +
              `total=${capCheck.totalBefore}->${capCheck.totalAfter}, ` +
              `net=${capCheck.netBefore}->${capCheck.netAfter})`
            );
          }
        }

        // 2. HYBRID LAYERED MODEL
        const LAYER_OFFSETS = [-0.02, -0.01, 0.0, +0.01];
        const LAYER_MIN_EV = [0.006, 0.004, 0.002, 0.000];

        let edgePenalty = 0;
        // Fix 1: SOL Churn (High Volume / Low PnL fix)
        if (asset.symbol === "SOL") {
          edgePenalty += 0.015; 
        }

        // Fix 2: The "Break Even" Bucket (0.85-0.90 fix)
        // If we aren't 90% sure, we shouldn't be aggressive with layers
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
            logger.log(`Layer ${i}: skip @${target.toFixed(2)} (EV=${ev.toFixed(4)} < ${finalMinEv})`);
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
          if (!capCheck.ok) {
            logger.log(
              `Layer ${i} skip; cap hit. (reason=${capCheck.reason}, ` +
              `total=${capCheck.totalBefore}->${capCheck.totalAfter}, ` +
              `net=${capCheck.netBefore}->${capCheck.netAfter})`
            );
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
              price: limitPrice.toFixed(2), side: Side.BUY, size: layerSize, expiration: String(expiresAt)
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
            }

            addPosition(state, slug, lateSide, layerSize);
            state.sharesBoughtBySlug[slug] = (state.sharesBoughtBySlug[slug] || 0) + layerSize;
          } catch (err) {
            logger.log(`Error layer ${i}:`, err?.message || err);
          }
        }
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
    if (size <= 0) { logger.log(`EV>0 but size=0`); return; }

    const capCheck = canPlaceOrder(state, slug, best.side, size, asset.symbol);
    if (!capCheck.ok) { 
      logger.log(
        `Skip normal trade; cap hit. (reason=${capCheck.reason}, ` +
        `total=${capCheck.totalBefore}->${capCheck.totalAfter}, ` +
        `net=${capCheck.netBefore}->${capCheck.netAfter})`
      );
      return; 
    }

    logger.log(`SIGNAL: BUY ${best.side} @ ${best.ask.toFixed(2)} (Size: ${size})`);
    const resp = await client.createAndPostOrder({
      tokenID: best.side === "UP" ? upTokenId : downTokenId,
      price: best.ask.toFixed(2), side: Side.BUY, size, expiration: String(Math.floor(Date.now()/1000)+900)
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
        type: "NORMAL" // or "EXTREME" or "LATE_LAYER"
      });
    }

    addPosition(state, slug, best.side, size);
    state.sharesBoughtBySlug[slug] = (state.sharesBoughtBySlug[slug] || 0) + size;

  } catch (err) {
    logger.error("Exec failed:", err.message);
  } finally {
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
  } catch (e) { console.error("Pyth Batch Error", e.message); return {}; }
}

async function execAll() {
  console.log(`\n=== TICK ${new Date().toISOString()} ===`);
  const pythPrices = await getBatchPythPrices(ASSETS.map(a => a.pythId));
  await Promise.all(ASSETS.map(asset => {
    const priceData = pythPrices[asset.pythId];
    if (!priceData) return Promise.resolve();
    VolatilityManager.updatePriceHistory(asset.symbol, priceData.price);
    return execForAsset(asset, priceData);
  }));
  console.log("=== TICK END ===");
}

// === STARTUP & SCHEDULER ===
(async () => {
  console.log("Initializing Bot...");

  // 1. Warm up volatility with historical data
  const symbols = ASSETS.map(a => a.symbol);
  await VolatilityManager.backfillHistory(symbols);

  // 2. Start the loop ONLY after backfill is done
  console.log("Starting Cron...");
  cron.schedule(`*/${interval} * * * * *`, () => execAll().catch(console.error));
})();
