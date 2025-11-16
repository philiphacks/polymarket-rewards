// multi_crypto_updown_bot.mjs
import 'dotenv/config';
import cron from "node-cron";
import clob from "@polymarket/clob-client";
const { ClobClient, Side, OrderType } = clob;
import { Wallet } from "@ethersproject/wallet";
import fs from "fs";

// ---------- GLOBAL CONFIG ----------
let interval = 5; // seconds between runs

// Succinct logging config
const LOG_JSON_SUMMARY = false; // set to true for JSON META lines instead of human text

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
  BTC: 400,
  ETH: 400,
  SOL: 400,
  XRP: 400,
};

// Time / z thresholds & sanity checks
const MINUTES_LEFT = 3;    // only act in last X minutes (unless |z| big)
const MIN_EDGE_EARLY = 0.07;  // minsLeft > MINUTES_LEFT
const MIN_EDGE_LATE  = 0.05;  // minsLeft <= MINUTES_LEFT
const Z_MIN = 0.5;            // min |z| to even consider directional trade

// Dynamic Z_MAX
const Z_MAX_FAR_MINUTES = 10;
const Z_MAX_NEAR_MINUTES = 3;
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
    console.log("[VOL] Loaded sigma file keys:", Object.keys(parsed));
    return parsed;
  } catch (err) {
    console.error("[VOL] Failed to load btc_sigma_1m.json:", err);
    return {};
  }
}

// **NEW** mutable sigmaConfig that can be reloaded
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
    "BTC": 42,
    "ETH": 2.3,
    "SOL": 0.125,
    "XRP": 0.0017,
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
  const pLow  = 0.80;    // allow 80% right at expiry

  // clamp secsLeft to [0, maxSecs]
  const clamped = Math.max(0, Math.min(maxSecs, secsLeft));

  // t=0 at far end (2m), t=1 at expiry
  const t = (maxSecs - clamped) / maxSecs;

  // linear interpolation: pHigh -> pLow
  return pHigh + (pLow - pHigh) * t;
}

// ---------- SUMMARY LOGGER ----------

function logSummary(symbol, meta) {
  const {
    minsLeft,
    startPrice,
    currentPrice,
    z,
    pUp,
    pDown,
    sigmaPerMin,
    zMaxDynamic,
    decision,
    reason,
    existingSide,
    book,
    evSide,
    evPrice,
    evSize,
    lateSide,
    layers,
  } = meta;

  if (LOG_JSON_SUMMARY) {
    console.log(
      `[${symbol}] META ` +
      JSON.stringify({
        t_mins: Number(minsLeft.toFixed(3)),
        start: Number(startPrice.toFixed(6)),
        cur: Number(currentPrice.toFixed(6)),
        z: Number(z.toFixed(4)),
        pUp: Number(pUp.toFixed(4)),
        pDown: Number(pDown.toFixed(4)),
        sigma1m: Number(sigmaPerMin.toFixed(4)),
        zMax: Number(zMaxDynamic.toFixed(4)),
        decision,
        reason,
        existingSide,
        book,
        ev: evSide
          ? { side: evSide, price: evPrice, size: evSize }
          : null,
        late: lateSide
          ? { side: lateSide, layers }
          : null,
      })
    );
  } else {
    let line =
      `[${symbol}] t-${minsLeft.toFixed(1)}m` +
      ` start=${startPrice.toFixed(2)}` +
      ` cur=${currentPrice.toFixed(2)}` +
      ` z=${z.toFixed(2)}` +
      ` pUp=${pUp.toFixed(3)}` +
      ` pDn=${pDown.toFixed(3)}` +
      ` σ1m=${sigmaPerMin.toFixed(3)}` +
      ` Zmax=${zMaxDynamic.toFixed(2)}` +
      ` side=${existingSide || "FLAT"}` +
      ` → ${decision}`;

    if (reason) line += ` (${reason})`;

    if (book && (book.upAsk != null || book.downAsk != null)) {
      const upStr = book.upAsk != null ? book.upAsk.toFixed(3) : "null";
      const dnStr = book.downAsk != null ? book.downAsk.toFixed(3) : "null";
      line += ` | asks U/D=${upStr}/${dnStr}`;
    }

    if (evSide && evPrice != null && evSize) {
      line += ` | EV ${evSide}@${evPrice.toFixed(2)}x${evSize}`;
    }

    if (lateSide && layers && layers.length > 0) {
      const ls = layers
        .map(l => `${l.price.toFixed(2)}x${l.size}`)
        .join(", ");
      line += ` | LATE ${lateSide} [${ls}]`;
    }

    console.log(line);
  }
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

// ---------- CORE EXECUTION PER ASSET ----------
async function execForAsset(asset) {
  const state = ensureState(asset);
  if (state.resetting) return;

  const { slug, cryptoPriceUrl, gammaUrl } = state;

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
      endDate: market.endDate,
    };

    console.log(
      `[${asset.symbol}] Cached marketMeta for slug=${slug}, id=${market.id}`
    );
  }

  const { endMs, tokenIds } = state.marketMeta;
  const nowMs = Date.now();
  const minsLeft = Math.max((endMs - nowMs) / 60000, 0.001);

  if (minsLeft > 14) return;

  // If market basically over, wait a bit and reset to next 15m market
  if (minsLeft < 0.01) {
    state.resetting = true;
    console.log(`[${asset.symbol}] Interval over. Resetting in 30s...`);
    await sleep(30_000);
    resetStateForAsset(asset);
    return;
  }

  // 2) Fetch start price (openPrice) from Polymarket crypto-price API (cached)
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

  // Sanity check: Polymarket vs Pyth
  const relDiff = Math.abs(currentPrice - startPrice) / startPrice;
  if (relDiff > MAX_REL_DIFF) {
    console.log(
      `[${asset.symbol}] Price sanity FAILED (>${MAX_REL_DIFF * 100}%). Skipping.`,
      { startPrice, currentPrice, relDiff }
    );
    return;
  }

  // 4) Compute probability Up using per-asset σ
  const SIGMA_PER_MIN = getSigmaPerMinUSD(asset.symbol);
  const sigmaT = SIGMA_PER_MIN * Math.sqrt(minsLeft);
  const diff = currentPrice - startPrice;
  const z = diff / sigmaT;
  const pUp = normCdf(z);
  const pDown = 1 - pUp;

  const zMaxDynamic = dynamicZMax(minsLeft);

  // 5) Order books
  const upTokenId = tokenIds[0];
  const downTokenId = tokenIds[1];

  const [upBook, downBook] = await Promise.all([
    client.getOrderBook(upTokenId),
    client.getOrderBook(downTokenId),
  ]);

  const { bestAsk: upAsk } = getBestBidAsk(upBook);
  const { bestAsk: downAsk } = getBestBidAsk(downBook);

  // Per-tick summary accumulator
  const existingSide = getExistingSide(state, slug);
  const summary = {
    minsLeft,
    startPrice,
    currentPrice,
    z,
    pUp,
    pDown,
    sigmaPerMin: SIGMA_PER_MIN,
    zMaxDynamic,
    decision: "NO_TRADE",
    reason: "",
    existingSide,
    book: {
      upAsk: upAsk ?? null,
      downAsk: downAsk ?? null,
    },
    evSide: null,
    evPrice: null,
    evSize: null,
    lateSide: null,
    layers: [],
  };

  if (upAsk == null && downAsk == null) {
    summary.decision = "NO_TRADE";
    summary.reason = "no_asks";
    logSummary(asset.symbol, summary);
    return;
  }

  // Early filter on |z| & time
  if ((Math.abs(z) < zMaxDynamic || Math.abs(z) > 5) && minsLeft > MINUTES_LEFT) {
    summary.decision = "NO_TRADE";
    summary.reason = "early_small_z";
    logSummary(asset.symbol, summary);
    return;
  }

  // Directional buy-only logic (EV candidates)
  let candidates = [];

  if (z >= Z_MIN && upAsk != null) {
    const evBuyUp = pUp - upAsk;
    candidates.push({ side: "UP", ev: evBuyUp, ask: upAsk });
  }

  if (z <= -Z_MIN && downAsk != null) {
    const evBuyDown = pDown - downAsk;
    candidates.push({ side: "DOWN", ev: evBuyDown, ask: downAsk });
  }

  // Filter by EV threshold
  const minEdge = minsLeft > MINUTES_LEFT ? MIN_EDGE_EARLY : MIN_EDGE_LATE;
  candidates = candidates.filter((c) => c.ev > minEdge);

  // ---------- Late-game layered mode ----------
  if (Math.abs(z) > zMaxDynamic || (minsLeft < 2 && minsLeft > 0.001)) {
    const expiresAt = Math.floor(Date.now() / 1000) + 15 * 60;
    const secsLeft = minsLeft * 60;
    const pReq = requiredLateProb(secsLeft);

    let lateSide = null;
    let sideProb = null;
    let sideAsk = null;

    if (pUp >= pReq && z > Z_MIN) {
      lateSide = "UP";
      sideProb = pUp;
      sideAsk = upAsk || 0.99;
    } else if (pDown >= pReq && z < -Z_MIN) {
      lateSide = "DOWN";
      sideProb = pDown;
      sideAsk = downAsk || 0.99;
    }

    if (lateSide && sideAsk != null) {
      // Hybrid layered model
      const LAYER_OFFSETS = [-0.03, -0.01, 0.0];
      const LAYER_SIZES = [40, 40, 20];
      // const MIN_LATE_LAYER_EV = 0.03; // currently unused (could be turned on again)

      const layersPlaced = [];

      for (let i = 0; i < LAYER_OFFSETS.length; i++) {
        let target = sideAsk + LAYER_OFFSETS[i];
        target = Math.max(0.01, Math.min(target, 0.99));

        const ev = sideProb - target;

        let layerSize = LAYER_SIZES[i];
        const capCheck = canPlaceOrder(
          state,
          slug,
          lateSide,
          layerSize,
          asset.symbol
        );
        if (!capCheck.ok) {
          continue;
        }

        const limitPrice = Number(target.toFixed(2));
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

          // You still have the raw response for debugging if needed:
          // console.log(`[${asset.symbol}] LATE LAYER ${i} RESP:`, resp);

          const currentShares = state.sharesBoughtBySlug[slug] || 0;
          state.sharesBoughtBySlug[slug] = currentShares + layerSize;
          addPosition(state, slug, lateSide, layerSize);

          layersPlaced.push({ price: limitPrice, size: layerSize, ev });
        } catch (err) {
          console.log(
            `[${asset.symbol}] Error placing late layer ${i}:`,
            err?.message || err
          );
        }
      }

      if (layersPlaced.length > 0) {
        summary.decision = "LATE_LAYERS";
        summary.reason = `late_layers_${lateSide.toLowerCase()}`;
        summary.lateSide = lateSide;
        summary.layers = layersPlaced;
      }
    }
  }

  // ---------- Normal EV-based entries ----------
  if (candidates.length === 0) {
    if (summary.decision === "NO_TRADE") {
      summary.decision = "NO_TRADE";
      summary.reason = "no_ev_candidate";
    }
    logSummary(asset.symbol, summary);
    return;
  }

  const best = candidates.reduce((a, b) => (b.ev > a.ev ? b : a));
  const size = 100;
  const capCheck = canPlaceOrder(state, slug, best.side, size, asset.symbol);
  if (!capCheck.ok) {
    if (summary.decision === "NO_TRADE") {
      summary.decision = "NO_TRADE";
      summary.reason = "cap_hit_not_hedge";
    }
    logSummary(asset.symbol, summary);
    return;
  }

  const expiresAt = Math.floor(Date.now() / 1000) + 15 * 60;
  const resp = await client.createAndPostOrder(
    {
      tokenID: best.side === "UP" ? upTokenId : downTokenId,
      price: best.ask.toFixed(2),
      side: Side.BUY,
      size,
      expiration: String(expiresAt),
    },
    { tickSize: "0.01", negRisk: false },
    OrderType.GTD
  );

  // console.log(`[${asset.symbol}] ORDER RESP:`, resp);

  const currentShares = state.sharesBoughtBySlug[slug] || 0;
  state.sharesBoughtBySlug[slug] = currentShares + size;
  addPosition(state, slug, best.side, size);

  summary.decision =
    summary.decision === "LATE_LAYERS" ? "LATE+EV_BUY" : "EV_BUY";
  summary.reason =
    summary.decision === "EV_BUY"
      ? `ev_${best.side.toLowerCase()}`
      : `${summary.reason}_and_ev_${best.side.toLowerCase()}`;
  summary.evSide = best.side;
  summary.evPrice = best.ask;
  summary.evSize = size;

  logSummary(asset.symbol, summary);
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
    console.error("Fatal error in main():", err);
    process.exit(1);
  });
});

cron.schedule("0 0 */2 * * *", () => {
  console.log("\n[VOL] Reloading btc_sigma_1m.json (2h refresh)...");
  sigmaConfig = loadSigmaConfig();
});
