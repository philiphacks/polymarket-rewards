#!/usr/bin/env node
import 'dotenv/config';
import { createPublicClient, http, formatUnits, getAddress } from 'viem';
import { mainnet } from 'viem/chains';
// https://docs.pyth.network/price-feeds/core/fetch-price-updates

// ===== CONFIG =====
const RPC_URL = process.env.RPC_URL;
if (!RPC_URL) {
  console.error('Set RPC_URL in .env (e.g., https://mainnet.infura.io/v3/<KEY>)');
  process.exit(1);
}

// Pyth BTC/USD price feed id (EVM)
const PYTH_PRICE_ID =
  '0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43';

// Use the stable “price_feeds/latest” endpoint (JSON, no auth)
const PYTH_LATEST =
  `https://hermes.pyth.network/v2/price_feeds/latest?ids[]=${PYTH_PRICE_ID}`;

// Chainlink BTC/USD proxy (Ethereum mainnet), checksummed
const CHAINLINK_ADDR = getAddress('0xF4030086522a5bEEA4988F8cA5B36dbC97BeE88c');

const CL_ABI = [
  { type:'function', name:'decimals', stateMutability:'view', inputs:[], outputs:[{type:'uint8'}]},
  { type:'function', name:'latestRoundData', stateMutability:'view', inputs:[], outputs:[
    { type:'uint80' },     // roundId
    { type:'int256' },     // answer
    { type:'uint256' },    // startedAt
    { type:'uint256' },    // updatedAt
    { type:'uint80' }      // answeredInRound
  ]}
];

const POLL_MS = 1000;

const iso = (ms) => new Date(ms).toISOString();

// ===== CHAINLINK (on-chain) =====
async function makeChainlinkReader() {
  const client = createPublicClient({ chain: mainnet, transport: http(RPC_URL) });
  const decimals = await client.readContract({
    address: CHAINLINK_ADDR,
    abi: CL_ABI,
    functionName: 'decimals',
  });

  async function read() {
    const [, answer, , updatedAt] = await client.readContract({
      address: CHAINLINK_ADDR,
      abi: CL_ABI,
      functionName: 'latestRoundData',
    });
    const price = Number(formatUnits(answer, decimals));
    const tsMs = Number(updatedAt) * 1000;
    return { price, updatedAt: tsMs };
  }

  return { read };
}

// ===== PYTH (poll latest JSON) =====
async function readPythLatestOnce() {
  const url1 = `https://hermes.pyth.network/v2/price_feeds/latest?ids[]=${PYTH_PRICE_ID}`;
  const url2 = `https://hermes.pyth.network/v2/updates/price/latest?ids[]=${PYTH_PRICE_ID}`;

  // helper to coerce numeric fields
  const toNum = (x) => (x === null || x === undefined ? null : Number(x));

  const parse = (j) => {
    // shape A: price_feeds/latest
    const pf = j?.price_feeds?.find?.(x => x?.id?.toLowerCase() === PYTH_PRICE_ID.toLowerCase()) ?? j?.price_feeds?.[0];
    const a = pf?.price;
    if (a && a.expo !== undefined && a.price !== undefined) {
      const px = toNum(a.price) * Math.pow(10, toNum(a.expo));     // expo is negative
      const tsMs = toNum(a.publish_time) * 1000;
      if (Number.isFinite(px) && Number.isFinite(tsMs)) return { price: px, updatedAt: tsMs };
    }

    // shape B: updates/price/latest
    const b = j?.parsed?.find?.(x => x?.price?.feed_id?.toLowerCase() === PYTH_PRICE_ID.toLowerCase()) ?? j?.parsed?.[0];
    const p = b?.price;
    if (p && p.expo !== undefined && p.price !== undefined) {
      const px = toNum(p.price) * Math.pow(10, toNum(p.expo));
      const tsMs = toNum(p.publish_time ?? p.timestamp) * 1000;
      if (Number.isFinite(px) && Number.isFinite(tsMs)) return { price: px, updatedAt: tsMs };
    }
    return null;
  };

  // try url1 then url2
  for (const url of [url1, url2]) {
    try {
      const r = await fetch(url, { headers: { accept: 'application/json' } });
      if (!r.ok) continue;
      const j = await r.json();

      // one-time sample log to prove payload
      if (!readPythLatestOnce._logged) {
        console.log('[pyth sample]', JSON.stringify(j).slice(0, 240));
        readPythLatestOnce._logged = true;
      }

      const out = parse(j);
      if (out) return out;
    } catch (_) {}
  }
  return null;
}

// ===== MAIN LOOP =====
(async () => {
  console.log('timestamp\t\t\tpyth\t\t(updated)\t\tchainlink\t(updated)\tΔ (bps)');
  console.log('--------------------------------------------------------------------------------------------------');

  const cl = await makeChainlinkReader();

  async function tick() {
    try {
      const [pythRes, clRes] = await Promise.allSettled([
        readPythLatestOnce(),
        cl.read(),
      ]);

      const p = pythRes.status === 'fulfilled' ? pythRes.value : null;
      const c = clRes.status === 'fulfilled' ? clRes.value : null;

      const pPx = p?.price ?? null;
      const cPx = c?.price ?? null;
      const deltaBps = (pPx && cPx) ? (((pPx - cPx) / cPx) * 1e4) : null;

      console.log(
        `${new Date().toISOString()}\t` +
        `${pPx ? pPx.toFixed(2) : '—'}\t` +
        `${p?.updatedAt ? `(${iso(p.updatedAt)})` : ''}\t` +
        `${cPx ? cPx.toFixed(2) : '—'}\t` +
        `${c?.updatedAt ? `(${iso(c.updatedAt)})` : ''}\t` +
        `${deltaBps !== null ? deltaBps.toFixed(1) : '—'}`
      );
    } catch (e) {
      console.error('[tick error]', e?.message || e);
    } finally {
      setTimeout(tick, POLL_MS);
    }
  }

  tick();
})();
