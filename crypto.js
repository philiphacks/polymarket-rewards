// Version 1.0
// Since Nov 20th, 7pm CET

import 'dotenv/config';
import cron from "node-cron";
import clob from "@polymarket/clob-client";
const { ClobClient, Side, OrderType } = clob;
import { Wallet } from "@ethersproject/wallet";
import fs from "fs";

// ---------- GLOBAL CONFIG ----------
let interval = 5; // seconds between runs

// Per-asset config (Polymarket + Pyth)
const ASSETS = [
  {
    symbol: "BTC",
    slugPrefix: "btc",
    pythId: "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
    volKey: "BTC/USD",
  },
  {
    symbol: "ETH",
    slugPrefix: "eth",
    pythId: "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
    volKey: "ETH/USD",
  },
  {
    symbol: "SOL",
    slugPrefix: "sol",
    pythId: "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
    volKey: "SOL/USD",
  },
  {
    symbol: "XRP",
    slugPrefix: "xrp",
    pythId: "0xec5d399846a9209f3fe5881d70aae9268c94339ff9817e8d18ff19fa05eea1c8",
    volKey: "XRP/USD",
  },
];

// Max shares per 15m market *per asset*
const MAX_SHARES_PER_MARKET = {
  BTC: 600,
  ETH: 300,
  SOL: 300,
  XRP: 200,
};

// Time / z thresholds & sanity checks
const MINUTES_LEFT = 3;      // only act in last X minutes (unless |z| big)
const MIN_EDGE_EARLY = 0.05; // minsLeft > MINUTES_LEFT
const MIN_EDGE_LATE  = 0.03; // minsLeft <= MINUTES_LEFT

// z-thresholds
const Z_MIN_EARLY = 1.2;    // directional entries ≥ 3m left
const Z_MIN_LATE  = 0.7;    // in the last 2–3m we accept smaller z if EV is big

const Z_MAX_FAR_MINUTES = 6;
const Z_MAX_NEAR_MINUTES = 3;

// Extreme late-game constants
const Z_HUGE = 4.0;
const LATE_GAME_EXTREME_SECS = 8;   // only consider extreme mode in last 8 seconds
const LATE_GAME_MAX_FRACTION = 0.3; // max 30% of per-market cap in extreme mode
const LATE_GAME_MIN_EV = 0.01;      // require at least 1% edge in extreme mode
const LATE_GAME_MAX_PRICE = 0.98;   // don't pay above 0.98 even in extreme mode

// Risk band thresholds
const PRICE_MIN_CORE = 0.90;   // only "core" strategy if paying ≥90c
const PROB_MIN_CORE  = 0.97;   // and model prob ≥97%
const PRICE_MAX_RISKY = 0.90;  // "risky" if cheaper than 90c
const PROB_MAX_RISKY  = 0.95;  // and prob ≤95%

const Z_MAX_FAR = 2.5;
const Z_MAX_NEAR = 1.7;
const MAX_REL_DIFF = 0.05; // 5% sanity check between start & current price

// CLOB / signing
const CLOB_HOST = "https://clob.polymarket.com";
const CHAIN_ID = 137;
const SIGNATURE_TYPE = 1;
const FUNDER = "0xA69b1867a00c87928b5A1f6B1c2e9aC2246bD844";

const signer = new Wallet(process.env.PRIVATE_KEY);
const credsP = new ClobClient(CLOB_HOST, CHAIN_ID, signer).createOrDeriveApiKey();
const creds = await credsP;
console.log("Address:", await signer.getAddress());
const client = new ClobClient(CLOB_HOST, CHAIN_ID, signer, creds, SIGNATURE_TYPE, FUNDER);

// Vol config (multi-asset) from btc_sigma_1m.json
function loadSigmaConfig() {
  try {
    const raw = fs.readFileSync("btc_sigma_1m.json", "utf8");
    const parsed = JSON.parse(raw);
    console.log(
      "[VOL] Loaded sigma file keys:",
      Object.keys(parsed)
    );
    return parsed;
  } catch (err) {
    console.error("[VOL] Failed to load btc_sigma_1m.json:", err);
    return {};
  }
}

// mutable sigmaConfig that can be reloaded
let sigmaConfig = loadSigmaConfig();
console.log("Loaded sigma file keys:", Object.keys(sigmaConfig));

// ---------- UTILS ----------

// Returns unix timestamp (seconds) of the start of the current 15-min interval
function current15mStartUnix(date = new Date()) {
  const ms = date.getTime();
  const intervalMs = 15 * 60 * 1000;
  return Math.floor(ms / intervalMs) * (intervalMs / 1000);
}

// Generic slug for 15m up/down markets
function crypto15mSlug(slugPrefix, date = new Date()) {
  return `${slugPrefix}-updown-15m-${current15mStartUnix(date)}`;
}

// Start of the current 15-minute interval (UTC)
function current15mStartUTC(date = new Date()) {
  const d = new Date(date);
  d.setUTCMinutes(Math.floor(d.getUTCMinutes() / 15) * 15, 0, 0);
  return d;
}

// End of the current 15-minute interval (UTC)
function current15mEndUTC(date = new Date()) {
  const start = current15mStartUTC(date);
  return new Date(start.getTime() + 15 * 60 * 1000);
}

// ISO without milliseconds
function isoNoMs(d) {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

// Polymarket crypto-price URL for a symbol
function cryptoPriceUrl({ symbol, date = new Date(), variant = "fifteen" }) {
  const start = current15mStartUTC(date);
  const end = current15mEndUTC(date);

  const base = "https://polymarket.com/api/crypto/crypto-price";
  const params = new URLSearchParams({
    symbol,
    eventStartTime: isoNoMs(start),
    variant,
    endDate: isoNoMs(end),
  });
  return `${base}?${params.toString()}`;
}

// Normal CDF (approx)
function normCdf(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp(-0.5 * z * z);
  let p =
    d *
    t *
    (0.3193815 +
      t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  if (z > 0) p = 1 - p;
  return p;
}

function dynamicZMax(minsLeft) {
  if (minsLeft >= Z_MAX_FAR_MINUTES) return Z_MAX_FAR;
  if (minsLeft <= Z_MAX_NEAR_MINUTES) return Z_MAX_NEAR;

  const t =
    (Z_MAX_FAR_MINUTES - minsLeft) /
    (Z_MAX_FAR_MINUTES - Z_MAX_NEAR_MINUTES);
  return Z_MAX_FAR - t * (Z_MAX_FAR - Z_MAX_NEAR);
}

// helper to check if we can place an order given caps
function canPlaceOrder(state, slug, side, size, assetSymbol) {
  const totalCap = getMaxSharesForMarket(assetSymbol);

  const totalBefore = state.sharesBoughtBySlug[slug] || 0;

  const pos = state.sideSharesBySlug[slug] || { UP: 0, DOWN: 0 };
  const upBefore = pos.UP || 0;
  const downBefore = pos.DOWN || 0;

  const netBefore = upBefore - downBefore;
  const sideSign = side === "UP" ? 1 : -1;
  const netAfter = netBefore + sideSign * size;

  const totalAfter = totalBefore + size;

  // Case 1: within total cap => always allowed
  if (totalAfter <= totalCap) {
    return {
      ok: true,
      reason: "within_cap",
      totalBefore,
      totalAfter,
      netBefore,
      netAfter,
    };
  }

  // Case 2: exceeding total cap, only allow if hedge (reduces |net|)
  if (Math.abs(netAfter) < Math.abs(netBefore)) {
    return {
      ok: true,
      reason: "hedge_beyond_cap",
      totalBefore,
      totalAfter,
      netBefore,
      netAfter,
    };
  }

  // Otherwise: reject – would add risk beyond cap
  return {
    ok: false,
    reason: "risk_increase_beyond_cap",
    totalBefore,
    totalAfter,
    netBefore,
    netAfter,
  };
}

// Best bid/ask from order book
function getBestBidAsk(ob) {
  let bestBid = null;
  let bestAsk = null;

  if (Array.isArray(ob.bids) && ob.bids.length > 0) {
    bestBid = ob.bids.reduce(
      (max, o) => Math.max(max, Number(o.price)),
      -Infinity
    );
  }

  if (Array.isArray(ob.asks) && ob.asks.length > 0) {
    bestAsk = ob.asks.reduce(
      (min, o) => Math.min(min, Number(o.price)),
      Infinity
    );
  }

  return {
    bestBid: Number.isFinite(bestBid) ? bestBid : null,
    bestAsk: Number.isFinite(bestAsk) ? bestAsk : null,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Get per-asset sigma
function getSigmaPerMinUSD(volKey) {
  const floorByAsset = {
    "BTC": 70,   // was 45
    "ETH": 4.0,  // was 2.5
    "SOL": 0.20, // was 0.125
    "XRP": 0.0035,
  };

  const assets = sigmaConfig.assets || {};
  const entry = assets[volKey];

  let sigma = entry && typeof entry.sigmaPerMinUSD === "number"
    ? entry.sigmaPerMinUSD
    : floorByAsset[volKey];

  // Enforce floor
  const floor = floorByAsset[volKey];
  if (typeof floor === "number" && typeof sigma === "number") {
    sigma = Math.max(sigma, floor);
  }

  return sigma;
}

// Effective per-minute sigma that shrinks in the last seconds before expiry.
// We keep the same 1-minute floor (e.g. 70 USD for BTC), but as minsLeft -> 0
// we reduce sigma so the model can become more decisive.
function effectiveSigmaPerMin(volKey, minsLeft) {
  // 1) Baseline per-minute sigma from config/floor
  const baseSigma = getSigmaPerMinUSD(volKey);

  // 2) For most of the window (>= 1 minute left), don't touch it.
  if (minsLeft >= 1) {
    return baseSigma;
  }

  // 3) Work in seconds for clarity
  const secsLeft = minsLeft * 60;

  // We start shrinking inside the last 30 seconds.
  // At 30s: factor = 1.0 (no shrink)
  // At 0s:  factor = MIN_FACTOR (e.g. 0.6 -> 60% of base sigma)
  const SHRINK_WINDOW_SECS = 30;
  const MIN_FACTOR = 0.6;

  // If we are still more than 30s away (but < 60s because of the minsLeft>=1 check),
  // don't shrink yet: sigma = baseSigma.
  if (secsLeft >= SHRINK_WINDOW_SECS) {
    return baseSigma;
  }

  // 4) t goes from 0 (at 30s) to 1 (at 0s)
  const t = Math.max(
    0,
    Math.min(1, (SHRINK_WINDOW_SECS - secsLeft) / SHRINK_WINDOW_SECS)
  );

  // Linear interpolation: factor = 1 -> MIN_FACTOR over the last 30 seconds
  const factor = 1 - t * (1 - MIN_FACTOR);

  return baseSigma * factor;
}

function getExistingSide(state, slug) {
  const sidePos = state.sideSharesBySlug?.[slug];
  if (!sidePos) return null;

  const up = sidePos.UP || 0;
  const down = sidePos.DOWN || 0;

  if (up > down) return "UP";
  if (down > up) return "DOWN";
  return null; // roughly flat
}

// helper to bump side position after trade
function addPosition(state, slug, side, size) {
  if (!state.sideSharesBySlug[slug]) {
    state.sideSharesBySlug[slug] = { UP: 0, DOWN: 0 };
  }
  state.sideSharesBySlug[slug][side] =
    (state.sideSharesBySlug[slug][side] || 0) + size;
}

function requiredLateProb(secsLeft) {
  const maxSecs = 120;   // 2 minutes window
  const pHigh = 0.90;    // require 90% when 2m left
  const pLow  = 0.85;    // allow 85% right at expiry

  // clamp secsLeft to [0, maxSecs]
  const clamped = Math.max(0, Math.min(maxSecs, secsLeft));

  // t=0 at far end (2m), t=1 at expiry
  const t = (maxSecs - clamped) / maxSecs;

  // linear interpolation: pHigh -> pLow
  return pHigh + (pLow - pHigh) * t;
}

// ---------- PER-ASSET STATE ----------
const stateBySymbol = {};

// Initialize/Reset state for an asset (new 15m window)
function resetStateForAsset(asset) {
  const slug = crypto15mSlug(asset.slugPrefix);
  const cryptoUrl = cryptoPriceUrl({ symbol: asset.symbol });
  const gammaUrl = `https://gamma-api.polymarket.com/markets/slug/${slug}`;

  stateBySymbol[asset.symbol] = {
    slug,
    cryptoPriceUrl: cryptoUrl,
    gammaUrl,
    sharesBoughtBySlug: { [slug]: 0 }, // track per-market
    sideSharesBySlug: { [slug]: { UP: 0, DOWN: 0 } },
    resetting: false,
    cpData: null,
    marketMeta: null,
  };

  console.log(
    `[${asset.symbol}] Reset: slug=${slug}, cryptoPriceUrl=${cryptoUrl}, gammaUrl=${gammaUrl}`
  );
}

// Ensure state exists
function ensureState(asset) {
  if (!stateBySymbol[asset.symbol]) {
    resetStateForAsset(asset);
  }
  return stateBySymbol[asset.symbol];
}

function getMaxSharesForMarket(volKey) {
  return MAX_SHARES_PER_MARKET[volKey] || 500;
}

// Approximate US "slam" window: ~9:45–10:00 ET (14:45–15:00 UTC in Nov)
function isInSlamWindow(date = new Date()) {
  const hours = date.getUTCHours();
  const mins  = date.getUTCMinutes();

  const totalMins = hours * 60 + mins;
  const start = 14 * 60 + 45; // 14:45 UTC
  const end   = 15 * 60;      // 15:00 UTC

  return totalMins >= start && totalMins < end;
}

// ---------- JSON TICK LOGGING (Step A) ----------
// One JSON line per asset per tick, for offline backtesting.
// This is side-effect-y (file IO) but *not* used in decision logic.
function logTickSnapshot(snapshot) {
  try {
    const d = new Date(snapshot.ts);
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(d.getUTCDate()).padStart(2, "0");

    // Per-day file, all assets together
    const filename = `ticks-${yyyy}${mm}${dd}.jsonl`;

    fs.appendFile(
      filename,
      JSON.stringify(snapshot) + "\n",
      (err) => {
        if (err) {
          console.error("[TICK-LOG] Error appending snapshot:", err);
        }
      }
    );
  } catch (err) {
    console.error("[TICK-LOG] Failed to log snapshot:", err);
  }
}

// Smart sizing based on EV, time left, and risk band
function sizeForTrade(ev, minsLeft, opts = {}) {
  const { minEdgeOverride = null, riskBand: riskBandOpt = "medium" } = opts;

  // Use global thresholds unless an override is provided
  const minEdge =
    minEdgeOverride !== null
      ? minEdgeOverride
      : minsLeft > MINUTES_LEFT
      ? MIN_EDGE_EARLY
      : MIN_EDGE_LATE;

  // Safety: if we don't clear min edge, size = 0 (caller can skip trade)
  if (ev <= minEdge) return 0;

  // --- Base caps by risk band --------------------------------
  let BASE_MIN, BASE_MAX, ABS_MAX, EV_CAP;
  if (riskBandOpt === "core") {
    BASE_MIN = 60;
    BASE_MAX = 180;
    ABS_MAX  = 250;
    EV_CAP   = 0.18;
  } else if (riskBandOpt === "risky") {
    BASE_MIN = 10;
    BASE_MAX = 40;
    ABS_MAX  = 60;
    EV_CAP   = 0.08;
  } else {
    // "medium"
    BASE_MIN = 40;
    BASE_MAX = 120;
    ABS_MAX  = 160;
    EV_CAP   = 0.12;
  }

  // --- EV normalisation ------------------------------------
  const evClamped = Math.min(ev, EV_CAP);

  // Guard: avoid division by zero if someone sets EV_CAP == minEdge
  const effectiveMax = Math.max(EV_CAP, minEdge + 0.01);

  // Normalised EV: 0 when just above minEdge, 1 when near EV_CAP
  const evNorm = Math.min(
    1,
    (evClamped - minEdge) / (effectiveMax - minEdge)
  );

  // --- Time factor ------------------------------------------
  // Only care about the active decision window [0, MINUTES_LEFT]
  const clampedMins = Math.max(0, Math.min(MINUTES_LEFT, minsLeft));

  // timeNorm: 0 at MINUTES_LEFT (start of window), 1 at 0 (expiry)
  const timeNorm = 1 - clampedMins / MINUTES_LEFT;

  // Map time into a factor between ~0.7x and ~1.3x
  const timeFactor = 0.7 + 0.6 * timeNorm; // 0.7 .. 1.3

  // --- Base size band ---------------------------------------
  let size = BASE_MIN + evNorm * (BASE_MAX - BASE_MIN);

  // Apply time urgency
  size *= timeFactor;

  // --- Global per-trade sanity --------------------------------
  size = Math.min(size, ABS_MAX);

  // Round to nearest 10 shares for clean book
  size = Math.round(size / 10) * 10;

  return size;
}

// ---------- CORE EXECUTION PER ASSET ----------
async function execForAsset(asset) {
  const state = ensureState(asset);
  if (state.resetting) return;

  const { slug, cryptoPriceUrl, gammaUrl } = state;

  console.log(`\n\n===== ${asset.symbol} | slug=${slug} =====`);

  // 1) Fetch/cached market meta from Gamma
  if (!state.marketMeta || state.marketMeta.slug !== slug) {
    const gammaRes = await fetch(gammaUrl);
    if (!gammaRes.ok) {
      console.log(
        `[${asset.symbol}] Gamma request failed: ${gammaRes.status} ${gammaRes.statusText}`
      );
      return;
    }
    const market = await gammaRes.json();
    const endMs = new Date(market.endDate).getTime();
    const tokenIds = JSON.parse(market.clobTokenIds);

    state.marketMeta = {
      id: market.id,
      slug,
      question: market.question,
      endMs,
      tokenIds,
      endDate: market.endDate
    };

    console.log(
      `[${asset.symbol}] Cached marketMeta for slug=${slug}, id=${market.id}`
    );
  }

  const { question, endMs, endDate, tokenIds } = state.marketMeta;
  const nowMs = Date.now();
  const minsLeft = Math.max((endMs - nowMs) / 60000, 0.001);

  console.log(`[${asset.symbol}] Question:`, question);
  console.log(`[${asset.symbol}] End date:`, endDate);
  console.log(`[${asset.symbol}] Minutes left:`, minsLeft.toFixed(3));

  if (minsLeft > 14) return;

  // If market basically over, wait a bit and reset to next 15m market
  if (minsLeft < 0.01) {
    state.resetting = true;
    console.log(`[${asset.symbol}] Interval over. Resetting in 30s...`);
    await sleep(30_000);
    resetStateForAsset(asset);
    return;
  }

  if (isInSlamWindow()) {
    console.log(
      `[${asset.symbol}] In slam window (~9:45–10:00 ET). Skipping this interval.`
    );
    return;
  }

  // 2) Fetch start price (openPrice) from Polymarket crypto-price API
  let startPrice;

  if (
    state.cpData &&
    Number.isFinite(Number(state.cpData.openPrice)) && 
    Number(state.cpData.openPrice) > 0
  ) {
    startPrice = Number(state.cpData.openPrice);
  } else {
    const cpRes = await fetch(cryptoPriceUrl);

    if (cpRes.status === 429) {
      console.log(
        `[${asset.symbol}] crypto-price 429 (rate limited). Sleeping 3s and skipping this tick.`
      );
      await sleep(3000);
      return;
    }

    if (!cpRes.ok) {
      console.log(
        `[${asset.symbol}] crypto-price failed: ${cpRes.status} ${cpRes.statusText}`
      );
      return;
    }
    const cp = await cpRes.json();
    const candidate = Number(cp.openPrice);

    if (!Number.isFinite(candidate) || candidate <= 0) {
      console.log(
        `[${asset.symbol}] openPrice missing / non-numeric / non-positive (=${cp.openPrice}). Not caching; skipping this tick.`
      );
      return;
    }

    state.cpData = {
      ...cp,
      _cachedAt: Date.now(),
    };

    startPrice = candidate;
    console.log(
      `[${asset.symbol}] Start price (openPrice) fetched & cached:`,
      startPrice
    );
  }

  // 3) Fetch current price from Pyth Hermes (per-asset feed ID)
  const pythUrl =
    "https://hermes.pyth.network/api/latest_price_feeds?ids[]=" + asset.pythId;

  const pythRes = await fetch(pythUrl);
  if (!pythRes.ok) {
    console.log(
      `[${asset.symbol}] Pyth request failed: ${pythRes.status} ${pythRes.statusText}`
    );
    return;
  }
  const pythArr = await pythRes.json();
  const pyth0 = pythArr[0];
  const pythPriceObj = pyth0.price;

  const raw = Number(pythPriceObj.price);
  const expo = Number(pythPriceObj.expo);
  if (!Number.isFinite(raw) || !Number.isFinite(expo)) {
    console.log(`[${asset.symbol}] Pyth price/expo missing`);
    return;
  }
  const currentPrice = raw * Math.pow(10, expo);
  console.log(
    `[${asset.symbol}] Open price $${startPrice.toFixed(5)} vs current price (Pyth) $${currentPrice.toFixed(5)}`
  );

  // Sanity check: Polymarket vs Pyth
  const relDiff = Math.abs(currentPrice - startPrice) / startPrice;
  if (relDiff > MAX_REL_DIFF) {
    console.log(
      `[${asset.symbol}] Price sanity FAILED (>${MAX_REL_DIFF * 100}%). Skipping.`,
      { startPrice, currentPrice, relDiff }
    );
    return;
  }

  // 4) Compute probability Up using *effective* per-asset σ
  //    - base sigma comes from volKey (e.g. "BTC/USD")
  //    - effectiveSigmaPerMin shrinks it in the last seconds
  // const SIGMA_PER_MIN = getSigmaPerMinUSD(asset.symbol);
  const SIGMA_PER_MIN = effectiveSigmaPerMin(asset.symbol, minsLeft);
  const sigmaT = SIGMA_PER_MIN * Math.sqrt(minsLeft);
  const diff = currentPrice - startPrice;
  const z = diff / sigmaT;
  const pUp = normCdf(z);
  const pDown = 1 - pUp;

  console.log(
    `[${asset.symbol}] σ ${SIGMA_PER_MIN.toFixed(5)} | z-score: ${z.toFixed(3)} | Model P(Up): ${pUp.toFixed(4)} | Model P(Down): ${pDown.toFixed(4)}`
  );

  // 5) Order books
  const upTokenId = tokenIds[0];
  const downTokenId = tokenIds[1];

  const [upBook, downBook] = await Promise.all([
    client.getOrderBook(upTokenId),
    client.getOrderBook(downTokenId),
  ]);

  const { bestAsk: upAsk } = getBestBidAsk(upBook);
  const { bestAsk: downAsk } = getBestBidAsk(downBook);

  if (upAsk == null && downAsk == null) {
    console.log(`[${asset.symbol}] No asks on either side. No trade.`);
    return;
  }

  // ---------- Build & log snapshot for backtesting (Step A) ----------
  {
    const sharesUp = state.sideSharesBySlug[slug]?.UP || 0;
    const sharesDown = state.sideSharesBySlug[slug]?.DOWN || 0;
    const totalShares = state.sharesBoughtBySlug[slug] || 0;

    const snapshot = {
      ts: Date.now(),
      symbol: asset.symbol,
      slug,
      minsLeft,
      startPrice,
      currentPrice,
      sigmaPerMin: SIGMA_PER_MIN,
      z,
      pUp,
      pDown,
      upAsk,
      downAsk,
      sharesUp,
      sharesDown,
      totalShares,
    };

    logTickSnapshot(snapshot);
  }
  // -----------------------------------------------------------

  // Countersignal logging (no selling yet)
  if ((state.sharesBoughtBySlug[slug] || 0) > 0) {
    const pos = state.sideSharesBySlug[slug] || { UP: 0, DOWN: 0 };
    const upPos   = pos.UP   || 0;
    const downPos = pos.DOWN || 0;

    const THRESH_WEAK = 0.55;
    const THRESH_BAD  = 0.50;

    const upAskStr   = upAsk   != null ? upAsk.toFixed(3)   : "n/a";
    const downAskStr = downAsk != null ? downAsk.toFixed(3) : "n/a";

    const inDecisionWindow = minsLeft <= 4;

    if (upPos > 0 && inDecisionWindow) {
      if (pUp < THRESH_BAD) {
        console.log(
          `[${asset.symbol}][${slug}] >>> COUNTERSIGNAL (STRONG): holding ${upPos} UP ` +
          `but pUp=${pUp.toFixed(4)} (<${THRESH_BAD}), bestUpAsk=${upAskStr}`
        );
      } else if (pUp < THRESH_WEAK) {
        console.log(
          `[${asset.symbol}][${slug}] >>> COUNTERSIGNAL (WEAK): holding ${upPos} UP ` +
          `but pUp=${pUp.toFixed(4)} (<${THRESH_WEAK}), bestUpAsk=${upAskStr}`
        );
      }
    }

    if (downPos > 0 && inDecisionWindow) {
      if (pDown < THRESH_BAD) {
        console.log(
          `[${asset.symbol}][${slug}] >>> COUNTERSIGNAL (STRONG): holding ${downPos} DOWN ` +
          `but pDown=${pDown.toFixed(4)} (<${THRESH_BAD}), bestDownAsk=${downAskStr}`
        );
      } else if (pDown < THRESH_WEAK) {
        console.log(
          `[${asset.symbol}][${slug}] >>> COUNTERSIGNAL (WEAK): holding ${downPos} DOWN ` +
          `but pDown=${pDown.toFixed(4)} (<${THRESH_WEAK}), bestDownAsk=${downAskStr}`
        );
      }
    }
  }

  const zMaxDynamic = dynamicZMax(minsLeft);
  const absZ = Math.abs(z);

  // Time/z gate: don't even consider trades in bad regions
  if (
    minsLeft > 5 ||                                        // too early, always skip
    (minsLeft > MINUTES_LEFT && minsLeft <= 5 && absZ < Z_HUGE) || // 3–5m, only trade if |z| >= Z_HUGE
    (minsLeft <= MINUTES_LEFT && absZ < Z_MIN_LATE)        // ≤3m, require at least Z_MIN_LATE
  ) {
    const evUp = upAsk != null ? pUp - upAsk : 0;
    const evDown = downAsk != null ? pDown - downAsk : 0;
    console.log(
      `[${asset.symbol}] Skip: minsLeft=${minsLeft.toFixed(2)}, |z|=${absZ.toFixed(
        3
      )}, Z_HUGE=${Z_HUGE}, Z_MAXdyn=${zMaxDynamic.toFixed(3)}, ` +
      `EV buy Up (pUp - ask) = ${evUp.toFixed(4)}, ` +
      `EV buy Down (pDown - ask)= ${evDown.toFixed(4)}`
    );
    return;
  }

  const mid =
    upAsk != null && downAsk != null ? (upAsk + downAsk) / 2 : upAsk ?? downAsk;
  console.log(
    `[${asset.symbol}] Up ask / Down ask: ${upAsk?.toFixed(
      3
    )} / ${downAsk?.toFixed(3)}, mid≈${mid?.toFixed(3)}`
  );

  const existingSide = getExistingSide(state, slug);
  console.log(
    `[${asset.symbol}] Existing net side: ${existingSide || "FLAT"}`
  );

  // Directional buy-only logic
  const directionalZMin = minsLeft > MINUTES_LEFT ? Z_MIN_EARLY : Z_MIN_LATE;
  let candidates = [];

  if (z >= directionalZMin && upAsk != null) {
    const evBuyUp = pUp - upAsk;
    console.log(
      `[${asset.symbol}] Up ask=${upAsk.toFixed(
        3
      )}, EV buy Up (pUp - ask)= ${evBuyUp.toFixed(4)}`
    );
    candidates.push({ side: "UP", ev: evBuyUp, ask: upAsk });
  } else {
    console.log(
      `[${asset.symbol}] We don't buy Up here (z too small or no ask).`
    );
  }

  if (z <= -directionalZMin && downAsk != null) {
    const evBuyDown = pDown - downAsk;
    console.log(
      `[${asset.symbol}] Down ask=${downAsk.toFixed(
        3
      )}, EV buy Down (pDown - ask)= ${evBuyDown.toFixed(4)}`
    );
    candidates.push({ side: "DOWN", ev: evBuyDown, ask: downAsk });
  } else {
    console.log(
      `[${asset.symbol}] We don't buy Down here (|z| too small or no ask).`
    );
  }

  // Filter by EV threshold
  const minEdge = minsLeft > MINUTES_LEFT ? MIN_EDGE_EARLY : MIN_EDGE_LATE;
  candidates = candidates.filter((c) => c.ev > minEdge);

  // ---------- Late-game "all-in-ish" mode ----------
  if (Math.abs(z) > zMaxDynamic || (minsLeft < 2 && minsLeft > 0.001)) {
    const expiresAt = Math.floor(Date.now() / 1000) + 15 * 60;

    const secsLeft = minsLeft * 60;
    const pReq = requiredLateProb(secsLeft);

    let lateSide = null;
    let sideProb = null;
    let sideAsk = null;

    if (pUp >= pReq && z > Z_MIN_LATE) {
      lateSide = "UP";
      sideProb = pUp;
      sideAsk = upAsk || 0.99;
    } else if (pDown >= pReq && z < -Z_MIN_LATE) {
      lateSide = "DOWN";
      sideProb = pDown;
      sideAsk = downAsk || 0.99;
    }

    if (!lateSide || sideAsk == null) {
      console.log(`[${asset.symbol}] Late game: no eligible side/ask.`);
    } else {
      // ========= EXTREME-SIGNAL BIG BET MODE =========
      const extremeSignal =
        absZ >= Z_HUGE &&                         // huge z-score
        secsLeft <= LATE_GAME_EXTREME_SECS &&     // last N seconds only
        sideAsk <= LATE_GAME_MAX_PRICE &&         // don't cross above 0.98
        (sideProb - sideAsk) >= LATE_GAME_MIN_EV; // require decent EV

      if (extremeSignal) {
        const maxShares = getMaxSharesForMarket(asset.symbol);
        let bigSize = Math.floor(maxShares * LATE_GAME_MAX_FRACTION);

        while (bigSize > 0) {
          const extremeCapCheck = canPlaceOrder(
            state,
            slug,
            lateSide,
            bigSize,
            asset.symbol
          );

          if (extremeCapCheck.ok) {
            if (extremeCapCheck.reason === "hedge_beyond_cap") {
              console.log(
                `[${asset.symbol}] EXTREME: hedge beyond cap allowed ` +
                `(net ${extremeCapCheck.netBefore} -> ${extremeCapCheck.netAfter}, ` +
                `total ${extremeCapCheck.totalBefore} -> ${extremeCapCheck.totalAfter})`
              );
            }

            const limitPrice = Number(
              Math.min(sideAsk, LATE_GAME_MAX_PRICE).toFixed(2)
            );

            console.log(
              `[${asset.symbol}] EXTREME SIGNAL: BUY ${lateSide} @ ${limitPrice}, ` +
              `size=${bigSize}, p=${sideProb.toFixed(4)}, EV=${(sideProb - limitPrice).toFixed(4)}, ` +
              `z=${z.toFixed(3)}, secsLeft=${secsLeft.toFixed(2)}`
            );

            const tokenID = lateSide === "UP" ? upTokenId : downTokenId;

            try {
              const resp = await client.createAndPostOrder(
                {
                  tokenID,
                  price: limitPrice,
                  side: Side.BUY,
                  size: bigSize,
                  expiration: String(expiresAt),
                },
                { tickSize: "0.01", negRisk: false },
                OrderType.GTD
              );

              console.log(`[${asset.symbol}] EXTREME ORDER RESP:`, resp);
              state.sharesBoughtBySlug[slug] =
                (state.sharesBoughtBySlug[slug] || 0) + bigSize;
              addPosition(state, slug, lateSide, bigSize);
            } catch (err) {
              console.log(
                `[${asset.symbol}] Error placing EXTREME order:`,
                err?.message || err
              );
            }

            // After an extreme bet, skip the normal layered logic
            return;
          }

          bigSize = Math.floor(bigSize / 2);
        }

        console.log(
          `[${asset.symbol}] EXTREME: could not find size that respects caps. Falling back to normal late-game layers.`
        );
      }
      // ========= END EXTREME-SIGNAL MODE =========

      // Hybrid layered model
      const LAYER_OFFSETS = [-0.02, -0.01, 0.0, +0.01];
      const LAYER_MIN_EV = [0.008, 0.006, 0.004, 0.000];

      console.log(
        `[${asset.symbol}] Late game hybrid: side=${lateSide}, ` +
        `prob=${sideProb.toFixed(4)}, ask=${sideAsk.toFixed(3)}`
      );

      for (let i = 0; i < LAYER_OFFSETS.length; i++) {
        let target = sideAsk + LAYER_OFFSETS[i];
        target = Math.max(0.01, Math.min(target, 0.99));

        const ev = sideProb - target;
        const minEv = LAYER_MIN_EV[i];
        if (ev < minEv) {
          console.log(
            `[${asset.symbol}] Layer ${i}: skip @${target.toFixed(
              2
            )} (EV=${ev.toFixed(4)} < ${minEv}).`
          );
          continue;
        }

        // Risk band for this layer based on prob & price
        let layerRiskBand = "medium";
        if (sideProb >= PROB_MIN_CORE && target >= PRICE_MIN_CORE) {
          layerRiskBand = "core";
        } else if (sideProb <= PROB_MAX_RISKY && target <= PRICE_MAX_RISKY) {
          layerRiskBand = "risky";
        }

        const layerSize = sizeForTrade(ev, minsLeft, {
          minEdgeOverride: 0.0,
          riskBand: layerRiskBand,
        });

        if (layerSize <= 0) {
          console.log(
            `[${asset.symbol}] Late layer ${i}: size <= 0 (ev=${ev.toFixed(
              4
            )}), skipping.`
          );
          continue;
        }

        const capCheck = canPlaceOrder(
          state,
          slug,
          lateSide,
          layerSize,
          asset.symbol
        );
        if (!capCheck.ok) {
          console.log(
            `[${asset.symbol}] Skipping layer ${i}; cap hit and not hedging. ` +
            `(reason=${capCheck.reason}, totalBefore=${capCheck.totalBefore}, totalAfter=${capCheck.totalAfter}, ` +
            `netBefore=${capCheck.netBefore}, netAfter=${capCheck.netAfter})`
          );
          continue;
        }

        if (capCheck.reason === "hedge_beyond_cap") {
          console.log(
            `[${asset.symbol}] Layer ${i} allowed beyond cap because it reduces net exposure. ` +
            `(net ${capCheck.netBefore} -> ${capCheck.netAfter}, total ${capCheck.totalBefore} -> ${capCheck.totalAfter})`
          );
        }

        const limitPrice = Number(target.toFixed(2));

        console.log(
          `[${asset.symbol}] Late layer ${i}: BUY ${lateSide} @ ${limitPrice}, ` +
          `size=${layerSize}, EV=${ev.toFixed(4)}`
        );

        const tokenID = lateSide === "UP" ? upTokenId : downTokenId;

        try {
          const resp = await client.createAndPostOrder(
            {
              tokenID,
              price: limitPrice,
              side: Side.BUY,
              size: layerSize,
              expiration: String(expiresAt),
            },
            { tickSize: "0.01", negRisk: false },
            OrderType.GTD
          );

          console.log(`[${asset.symbol}] LATE LAYER ${i} RESP:`, resp);
          state.sharesBoughtBySlug[slug] =
            (state.sharesBoughtBySlug[slug] || 0) + layerSize;
          addPosition(state, slug, lateSide, layerSize);
        } catch (err) {
          console.log(
            `[${asset.symbol}] Error placing late layer ${i}:`,
            err?.message || err
          );
        }
      }
    }
  }

  // ---------- Normal EV-based entries ----------
  if (candidates.length === 0) {
    console.log(
      `[${asset.symbol}] No trade: no side with enough edge in the right direction.`
    );
    return;
  }

  const best = candidates.reduce((a, b) => (b.ev > a.ev ? b : a));

  const sideProbBest = best.side === "UP" ? pUp : pDown;
  const bestPrice = best.ask;

  let riskBand = "medium";
  if (sideProbBest >= PROB_MIN_CORE && bestPrice >= PRICE_MIN_CORE) {
    riskBand = "core";
  } else if (sideProbBest <= PROB_MAX_RISKY && bestPrice <= PRICE_MAX_RISKY) {
    riskBand = "risky";
  }

  const size = sizeForTrade(best.ev, minsLeft, { riskBand });

  if (size <= 0) {
    console.log(
      `[${asset.symbol}] No trade: EV sizing returned 0 (ev=${best.ev.toFixed(
        4
      )}, minsLeft=${minsLeft.toFixed(2)}, riskBand=${riskBand})`
    );
    return;
  }

  const capCheck = canPlaceOrder(state, slug, best.side, size, asset.symbol);
  if (!capCheck.ok) {
    console.log(
      `[${asset.symbol}] Skipping EV buy; cap hit and not hedging. ` +
      `(reason=${capCheck.reason}, totalBefore=${capCheck.totalBefore}, totalAfter=${capCheck.totalAfter}, ` +
      `netBefore=${capCheck.netBefore}, netAfter=${capCheck.netAfter})`
    );
    return;
  }
  if (capCheck.reason === "hedge_beyond_cap") {
    console.log(
      `[${asset.symbol}] EV buy allowed beyond total cap because it reduces net exposure. ` +
      `(net ${capCheck.netBefore} -> ${capCheck.netAfter}, total ${capCheck.totalBefore} -> ${capCheck.totalAfter})`
    );
  }

  console.log(
    `[${asset.symbol}] >>> SIGNAL: BUY ${best.side} @ ${best.ask.toFixed(
      3
    )}, EV=${best.ev.toFixed(4)}, size=${size}, riskBand=${riskBand}`
  );

  const expiresAt2 = Math.floor(Date.now() / 1000) + 15 * 60;
  const resp = await client.createAndPostOrder(
    {
      tokenID: best.side === "UP" ? upTokenId : downTokenId,
      price: best.ask.toFixed(2),
      side: Side.BUY,
      size,
      expiration: String(expiresAt2),
    },
    { tickSize: "0.01", negRisk: false },
    OrderType.GTD
  );

  console.log(`[${asset.symbol}] ORDER RESP:`, resp);
  const currentShares = state.sharesBoughtBySlug[slug] || 0;
  state.sharesBoughtBySlug[slug] = currentShares + size;
  addPosition(state, slug, best.side, size);
}

// ---------- MAIN SCHEDULER ----------
async function execAll() {
  console.log("\n\n\n======================= RUN =======================");
  for (const asset of ASSETS) {
    try {
      await execForAsset(asset);
    } catch (err) {
      console.error(`[${asset.symbol}] ERROR:`, err);
    }
  }
}

cron.schedule(`*/${interval} * * * * *`, async () => {
  await execAll().catch((err) => {
    console.error('Fatal error in main():', err);
    process.exit(1);
  });
});

cron.schedule("0 */20 * * * *", () => {
  console.log("\n[VOL] Reloading btc_sigma_1m.json...");
  sigmaConfig = loadSigmaConfig();
});
