// backtest.mjs
// Offline backtester for the multi-crypto up/down bot
// - Reads JSONL tick snapshots (from logTickSnapshot in your live bot)
// - Reads positions-pnl.csv to get true outcomes per slug
// - Replays decision logic (slam window, time/z gating, extreme, layers, normal EV)
// - Simulates positions + caps and computes PnL.

// ----------------- IMPORTS -----------------
import fs from "fs";

// ----------------- CONFIG ------------------

// Tick snapshot files you want to backtest over.
// Adjust these filenames to match what your live bot produced.
const TICK_FILES = [
  "ticks-20251120.jsonl",
];

// CSV exported from your positions (the one you called positions-pnl.csv)
const POSITIONS_CSV = "positions-pnl.csv";

// Max shares per 15m market *per asset* (must match live bot)
const MAX_SHARES_PER_MARKET = {
  BTC: 600,
  ETH: 300,
  SOL: 300,
  XRP: 200,
};

// Time / z thresholds & sanity checks (must match live bot)
const MINUTES_LEFT = 3;
const MIN_EDGE_EARLY = 0.05;
const MIN_EDGE_LATE  = 0.03;

const Z_MIN_EARLY = 1.2;
const Z_MIN_LATE  = 0.7;

const Z_MAX_FAR_MINUTES = 6;
const Z_MAX_NEAR_MINUTES = 3;

const Z_HUGE = 4.0;
const LATE_GAME_EXTREME_SECS = 8;
const LATE_GAME_MAX_FRACTION = 0.3;
const LATE_GAME_MIN_EV = 0.01;
const LATE_GAME_MAX_PRICE = 0.98;

// Risk band thresholds (must match live bot)
const PRICE_MIN_CORE  = 0.90;
const PROB_MIN_CORE   = 0.97;
const PRICE_MAX_RISKY = 0.90;
const PROB_MAX_RISKY  = 0.95;

const Z_MAX_FAR = 2.5;
const Z_MAX_NEAR = 1.7;

// Enable/disable debug logs (keep false for large runs)
const DEBUG = false;

// ----------------- SMALL HELPERS ------------------

// Slam window: ~9:45–10:00 ET ≈ 14:45–15:00 UTC in Nov
function isInSlamWindow(date) {
  const hours = date.getUTCHours();
  const mins  = date.getUTCMinutes();
  const totalMins = hours * 60 + mins;

  const start = 14 * 60 + 45; // 14:45 UTC
  const end   = 15 * 60;      // 15:00 UTC

  return totalMins >= start && totalMins < end;
}

// Dynamic z cap (you had it in the live bot)
function dynamicZMax(minsLeft) {
  if (minsLeft >= Z_MAX_FAR_MINUTES) return Z_MAX_FAR;
  if (minsLeft <= Z_MAX_NEAR_MINUTES) return Z_MAX_NEAR;

  const t =
    (Z_MAX_FAR_MINUTES - minsLeft) /
    (Z_MAX_FAR_MINUTES - Z_MAX_NEAR_MINUTES);
  return Z_MAX_FAR - t * (Z_MAX_FAR - Z_MAX_NEAR);
}

// Simple CSV line parser with quote support (enough for positions-pnl.csv)
function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const c = line[i];

    if (c === '"') {
      if (inQuotes && line[i + 1] === '"') {
        // Escaped quote
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (c === "," && !inQuotes) {
      out.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];

  const header = parseCsvLine(lines[0]);
  const rows = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]);
    const obj = {};
    for (let j = 0; j < header.length; j++) {
      const key = header[j];
      obj[key] = cols[j] ?? "";
    }
    rows.push(obj);
  }

  return rows;
}

// ----------------- OUTCOMES FROM CSV ------------------

// We only care about slug -> outcome ("Up" / "Down").
function loadOutcomes(csvPath) {
  const raw = fs.readFileSync(csvPath, "utf8");
  const rows = parseCsv(raw);

  const outcomeBySlug = {};

  for (const row of rows) {
    const slug = row.slug;
    let outcome = row.outcome;

    if (!slug || !outcome) continue;

    outcome = outcome.trim().toUpperCase(); // "UP" / "DOWN"
    outcomeBySlug[slug] = outcome;
  }

  console.log(
    `[BACKTEST] Loaded outcomes for ${Object.keys(outcomeBySlug).length} slugs from ${csvPath}`
  );

  return outcomeBySlug;
}

// ----------------- STATE & CAPS ------------------

// Same structure as in live bot: per symbol we keep { sharesBoughtBySlug, sideSharesBySlug }
const simStateBySymbol = {};

// Ensure state object exists for a symbol
function ensureSimState(symbol) {
  if (!simStateBySymbol[symbol]) {
    simStateBySymbol[symbol] = {
      sharesBoughtBySlug: {},
      sideSharesBySlug: {}
    };
  }
  return simStateBySymbol[symbol];
}

function getMaxSharesForMarket(symbol) {
  return MAX_SHARES_PER_MARKET[symbol] || 500;
}

// Same canPlaceOrder as your live bot
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

  return {
    ok: false,
    reason: "risk_increase_beyond_cap",
    totalBefore,
    totalAfter,
    netBefore,
    netAfter,
  };
}

// Same addPosition helper
function addPosition(state, slug, side, size) {
  if (!state.sideSharesBySlug[slug]) {
    state.sideSharesBySlug[slug] = { UP: 0, DOWN: 0 };
  }
  state.sideSharesBySlug[slug][side] =
    (state.sideSharesBySlug[slug][side] || 0) + size;

  state.sharesBoughtBySlug[slug] =
    (state.sharesBoughtBySlug[slug] || 0) + size;
}

// ----------------- SIZING LOGIC ------------------

// (same as in your live code)
function sizeForTrade(ev, minsLeft, opts = {}) {
  const { minEdgeOverride = null, riskBand: riskBandOpt = "medium" } = opts;

  const minEdge =
    minEdgeOverride !== null
      ? minEdgeOverride
      : minsLeft > MINUTES_LEFT
      ? MIN_EDGE_EARLY
      : MIN_EDGE_LATE;

  if (ev <= minEdge) return 0;

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
    BASE_MIN = 40;
    BASE_MAX = 120;
    ABS_MAX  = 160;
    EV_CAP   = 0.12;
  }

  const evClamped = Math.min(ev, EV_CAP);
  const effectiveMax = Math.max(EV_CAP, minEdge + 0.01);

  const evNorm = Math.min(
    1,
    (evClamped - minEdge) / (effectiveMax - minEdge)
  );

  const clampedMins = Math.max(0, Math.min(MINUTES_LEFT, minsLeft));
  const timeNorm = 1 - clampedMins / MINUTES_LEFT;
  const timeFactor = 0.7 + 0.6 * timeNorm;

  let size = BASE_MIN + evNorm * (BASE_MAX - BASE_MIN);
  size *= timeFactor;

  size = Math.min(size, ABS_MAX);
  size = Math.round(size / 10) * 10;

  return size;
}

function requiredLateProb(secsLeft) {
  const maxSecs = 120;   // 2 minutes
  const pHigh = 0.90;
  const pLow  = 0.85;

  const clamped = Math.max(0, Math.min(maxSecs, secsLeft));
  const t = (maxSecs - clamped) / maxSecs;

  return pHigh + (pLow - pHigh) * t;
}

// ----------------- TICK LOADING ------------------

// Read all JSONL snapshots from the tick files
function loadSnapshots(files) {
  const snapshots = [];

  for (const file of files) {
    if (!fs.existsSync(file)) {
      console.warn(`[BACKTEST] Tick file not found: ${file}`);
      continue;
    }

    const text = fs.readFileSync(file, "utf8");
    const lines = text.split(/\r?\n/);

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const snap = JSON.parse(trimmed);
        snapshots.push(snap);
      } catch (err) {
        console.error(`[BACKTEST] Failed to parse JSONL line in ${file}:`, err);
      }
    }
  }

  console.log(`[BACKTEST] Loaded ${snapshots.length} tick snapshots`);
  return snapshots;
}

// Group snapshots by slug (keeping symbol)
function groupSnapshotsBySlug(snapshots) {
  const bySlug = new Map();

  for (const s of snapshots) {
    const slug = s.slug;
    if (!slug) continue;

    if (!bySlug.has(slug)) {
      bySlug.set(slug, {
        slug,
        symbol: s.symbol,
        snapshots: []
      });
    }
    bySlug.get(slug).snapshots.push(s);
  }

  // sort each slug's snapshots by timestamp
  for (const entry of bySlug.values()) {
    entry.snapshots.sort((a, b) => (a.ts || 0) - (b.ts || 0));
  }

  console.log(`[BACKTEST] Grouped into ${bySlug.size} slug-series`);
  return bySlug;
}

// ----------------- DECISION REPLAY ------------------

// This function mirrors your *live* trade logic using the snapshot data.
// It returns an array of "orders" applied at this tick.
//
// Each order: {
//   kind: "extreme" | "layer" | "normal",
//   symbol, slug,
//   side: "UP" | "DOWN",
//   size,      // shares
//   price,     // limit price
//   ev,        // p - price
//   riskBand,  // "core" | "medium" | "risky"
// }
function decideFromSnapshot(snapshot, simState, outcomeKnown) {
  const {
    ts,
    symbol,
    slug,
    minsLeft,
    z,
    pUp,
    pDown,
    upAsk,
    downAsk,
  } = snapshot;

  const orders = [];

  const now = new Date(ts);
  if (isInSlamWindow(now)) {
    if (DEBUG) {
      console.log(`[${symbol}][${slug}] Slam window -> no trades`);
    }
    return orders;
  }

  if (upAsk == null && downAsk == null) {
    if (DEBUG) {
      console.log(`[${symbol}][${slug}] No asks -> no trades`);
    }
    return orders;
  }

  const absZ = Math.abs(z);
  const zMaxDynamic = dynamicZMax(minsLeft);

  // Time/z gate – identical to your live bot
  if (
    minsLeft > 5 ||
    (minsLeft > MINUTES_LEFT && minsLeft <= 5 && absZ < Z_HUGE) ||
    (minsLeft <= MINUTES_LEFT && absZ < Z_MIN_LATE)
  ) {
    return orders;
  }

  // Directional candidates
  const directionalZMin = minsLeft > MINUTES_LEFT ? Z_MIN_EARLY : Z_MIN_LATE;
  let candidates = [];

  if (z >= directionalZMin && upAsk != null) {
    const evBuyUp = pUp - upAsk;
    candidates.push({ side: "UP", ev: evBuyUp, ask: upAsk });
  }

  if (z <= -directionalZMin && downAsk != null) {
    const evBuyDown = pDown - downAsk;
    candidates.push({ side: "DOWN", ev: evBuyDown, ask: downAsk });
  }

  const minEdge = minsLeft > MINUTES_LEFT ? MIN_EDGE_EARLY : MIN_EDGE_LATE;
  candidates = candidates.filter((c) => c.ev > minEdge);

  // --- Late-game extreme/layer logic ---
  if (Math.abs(z) > zMaxDynamic || (minsLeft < 2 && minsLeft > 0.001)) {
    const secsLeft = minsLeft * 60;
    const pReq = requiredLateProb(secsLeft);

    let lateSide = null;
    let sideProb = null;
    let sideAsk = null;

    if (pUp >= pReq && z > Z_MIN_LATE) {
      lateSide = "UP";
      sideProb = pUp;
      sideAsk = upAsk ?? 0.99;
    } else if (pDown >= pReq && z < -Z_MIN_LATE) {
      lateSide = "DOWN";
      sideProb = pDown;
      sideAsk = downAsk ?? 0.99;
    }

    if (lateSide && sideAsk != null) {
      // EXTREME MODE
      const extremeSignal =
        absZ >= Z_HUGE &&
        secsLeft <= LATE_GAME_EXTREME_SECS &&
        sideAsk <= LATE_GAME_MAX_PRICE &&
        (sideProb - sideAsk) >= LATE_GAME_MIN_EV;

      if (extremeSignal) {
        const maxShares = getMaxSharesForMarket(symbol);
        let bigSize = Math.floor(maxShares * LATE_GAME_MAX_FRACTION);

        while (bigSize > 0) {
          const capCheck = canPlaceOrder(
            simState,
            slug,
            lateSide,
            bigSize,
            symbol
          );

          if (capCheck.ok) {
            const limitPrice = Number(
              Math.min(sideAsk, LATE_GAME_MAX_PRICE).toFixed(2)
            );

            const ev = sideProb - limitPrice;

            orders.push({
              kind: "extreme",
              symbol,
              slug,
              side: lateSide,
              size: bigSize,
              price: limitPrice,
              ev,
              riskBand: "core",
            });

            // apply to sim state
            addPosition(simState, slug, lateSide, bigSize);

            // In live bot, extreme returns immediately (no layers/normal after)
            return orders;
          }

          bigSize = Math.floor(bigSize / 2);
        }

        // If we cannot place any extreme size, fall through to layers
      }

      // HYBRID LAYERED MODE
      const LAYER_OFFSETS = [-0.02, -0.01, 0.0, +0.01];
      const LAYER_MIN_EV  = [0.008, 0.006, 0.004, 0.000];

      for (let i = 0; i < LAYER_OFFSETS.length; i++) {
        let target = sideAsk + LAYER_OFFSETS[i];
        target = Math.max(0.01, Math.min(target, 0.99));

        const ev = sideProb - target;
        const minEvLayer = LAYER_MIN_EV[i];
        if (ev < minEvLayer) {
          continue;
        }

        // Risk band for layer
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
          continue;
        }

        const capCheck = canPlaceOrder(
          simState,
          slug,
          lateSide,
          layerSize,
          symbol
        );
        if (!capCheck.ok) {
          continue;
        }

        const limitPrice = Number(target.toFixed(2));

        orders.push({
          kind: "layer",
          symbol,
          slug,
          side: lateSide,
          size: layerSize,
          price: limitPrice,
          ev,
          riskBand: layerRiskBand,
        });

        addPosition(simState, slug, lateSide, layerSize);
      }
    }
  }

  // --- Normal EV-based entries ---
  if (candidates.length === 0) {
    return orders;
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
    return orders;
  }

  const capCheck = canPlaceOrder(simState, slug, best.side, size, symbol);
  if (!capCheck.ok) {
    return orders;
  }

  const limitPrice = Number(best.ask.toFixed(2));

  orders.push({
    kind: "normal",
    symbol,
    slug,
    side: best.side,
    size,
    price: limitPrice,
    ev: best.ev,
    riskBand,
  });

  addPosition(simState, slug, best.side, size);

  return orders;
}

// ----------------- PnL COMPUTATION ------------------

// Aggregate orders by slug+side, compute avg entry price & PnL with outcome.
function computePnL(allOrders, outcomeBySlug) {
  // trades[slug][side] = { totalSize, totalCost }
  const trades = {};

  for (const order of allOrders) {
    const { slug, side, size, price } = order;
    if (!trades[slug]) {
      trades[slug] = {
        UP: { totalSize: 0, totalCost: 0 },
        DOWN: { totalSize: 0, totalCost: 0 },
      };
    }
    const bucket = trades[slug][side];
    bucket.totalSize += size;
    bucket.totalCost += size * price;
  }

  let totalPnL = 0;
  const perSlugResults = [];

  for (const [slug, sides] of Object.entries(trades)) {
    const outcomeRaw = outcomeBySlug[slug];
    if (!outcomeRaw) {
      console.warn(`[BACKTEST] No outcome for slug ${slug}, skipping in PnL.`);
      continue;
    }
    const outcome = outcomeRaw.toUpperCase(); // "UP" / "DOWN"

    const upInfo = sides.UP;
    const downInfo = sides.DOWN;

    const avgUp   = upInfo.totalSize > 0 ? upInfo.totalCost / upInfo.totalSize : 0;
    const avgDown = downInfo.totalSize > 0 ? downInfo.totalCost / downInfo.totalSize : 0;

    const settleUp   = outcome === "UP"   ? 1 : 0;
    const settleDown = outcome === "DOWN" ? 1 : 0;

    const pnlUp   = upInfo.totalSize   * (settleUp   - avgUp);
    const pnlDown = downInfo.totalSize * (settleDown - avgDown);

    const pnlSlug = pnlUp + pnlDown;
    totalPnL += pnlSlug;

    perSlugResults.push({
      slug,
      outcome,
      sizeUp: upInfo.totalSize,
      avgUp,
      pnlUp,
      sizeDown: downInfo.totalSize,
      avgDown,
      pnlDown,
      pnlSlug,
    });
  }

  // Sort by PnL ascending for inspection
  perSlugResults.sort((a, b) => a.pnlSlug - b.pnlSlug);

  return { totalPnL, perSlugResults };
}

// ----------------- MAIN ------------------

async function main() {
  console.log("[BACKTEST] Starting...");

  const outcomeBySlug = loadOutcomes(POSITIONS_CSV);
  const snapshots = loadSnapshots(TICK_FILES);
  const bySlug = groupSnapshotsBySlug(snapshots);

  const allOrders = [];

  for (const { slug, symbol, snapshots: series } of bySlug.values()) {
    const simState = ensureSimState(symbol);

    const hasOutcome = !!outcomeBySlug[slug];

    for (const snap of series) {
      // We ignore sharesUp/sharesDown/totalShares in the snapshot for decisions;
      // we maintain our own simulated state via simState.
      const orders = decideFromSnapshot(snap, simState, hasOutcome);
      allOrders.push(...orders);
    }
  }

  console.log(`[BACKTEST] Total simulated orders: ${allOrders.length}`);

  const { totalPnL, perSlugResults } = computePnL(allOrders, outcomeBySlug);

  console.log("\n[BACKTEST] PnL by slug (worst to best):");
  for (const r of perSlugResults) {
    console.log(
      `${r.slug} | outcome=${r.outcome} | ` +
      `sizeUp=${r.sizeUp} @ ${r.avgUp.toFixed(3)} -> PnL=${r.pnlUp.toFixed(2)}, ` +
      `sizeDown=${r.sizeDown} @ ${r.avgDown.toFixed(3)} -> PnL=${r.pnlDown.toFixed(2)}, ` +
      `slugPnL=${r.pnlSlug.toFixed(2)}`
    );
  }

  console.log(`\n[BACKTEST] TOTAL PnL across all slugs: ${totalPnL.toFixed(2)}`);
}

main().catch((err) => {
  console.error("[BACKTEST] Fatal error:", err);
  process.exit(1);
});
