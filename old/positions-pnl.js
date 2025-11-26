// positions-pnl-from-api.js
// Usage:
//   node positions-pnl-from-api.js > pnl.csv
//
// Requires Node 18+ (for global fetch). If you're on an older version,
// `npm i node-fetch` and replace `fetch` with `require("node-fetch")`.

const ADDRESS = "0xA69b1867a00c87928b5A1f6B1c2e9aC2246bD844";
const LIMIT = 500;

const POSITIONS_URL = `https://data-api.polymarket.com/positions?user=${ADDRESS}&limit=${LIMIT}`;

// --- helpers ------------------------------------------------------------

function toNumber(x) {
  if (x === null || x === undefined || Number.isNaN(Number(x))) return "";
  return Number(x);
}

function csvEscape(value) {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (/[",\n]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

// --- main ---------------------------------------------------------------

async function main() {
  // Fetch positions from Polymarket Data API
  const res = await fetch(POSITIONS_URL);
  if (!res.ok) {
    console.error("Error fetching positions:", res.status, res.statusText);
    process.exit(1);
  }

  /** @type {any} */
  const json = await res.json();

  // Some APIs wrap results; for Polymarket it's usually a bare array,
  // but we'll be defensive.
  const positions = Array.isArray(json)
    ? json
    : Array.isArray(json.positions)
    ? json.positions
    : [];

  if (!positions.length) {
    console.error("No positions found or unexpected API response.");
    process.exit(1);
  }

  const headers = [
    "title",
    "slug",
    "outcome",
    "size",
    "avgPrice",
    "initialValue",
    "currentValue",
    "cashPnl",
    "percentPnl",
    "realizedPnl",
    "percentRealizedPnl",
    "curPrice",
    "redeemable",
    "negativeRisk",
    "approxUnrealizedPnl",
    "approxTotalPnl",
  ];

  console.log(headers.map(csvEscape).join(","));

  for (const p of positions) {
    const title = p.title ?? "";
    const slug = p.slug ?? p.eventSlug ?? "";
    const outcome = p.outcome ?? "";
    const size = toNumber(p.size);
    const avgPrice = toNumber(p.avgPrice);
    const initialValue = toNumber(p.initialValue);
    const currentValue = toNumber(p.currentValue);
    const cashPnl = toNumber(p.cashPnl);
    const percentPnl = toNumber(p.percentPnl);
    const realizedPnl = toNumber(p.realizedPnl);
    const percentRealizedPnl = toNumber(p.percentRealizedPnl);
    const curPrice = toNumber(p.curPrice);
    const redeemable = p.redeemable === true ? 1 : 0;
    const negativeRisk = p.negativeRisk === true ? 1 : 0;

    const approxUnrealizedPnl =
      initialValue !== "" && currentValue !== ""
        ? currentValue - initialValue
        : "";
    const approxTotalPnl =
      cashPnl !== "" && approxUnrealizedPnl !== ""
        ? cashPnl + approxUnrealizedPnl
        : "";

    const row = [
      title,
      slug,
      outcome,
      size,
      avgPrice,
      initialValue,
      currentValue,
      cashPnl,
      percentPnl,
      realizedPnl,
      percentRealizedPnl,
      curPrice,
      redeemable,
      negativeRisk,
      approxUnrealizedPnl,
      approxTotalPnl,
    ].map(csvEscape);

    console.log(row.join(","));
  }
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
