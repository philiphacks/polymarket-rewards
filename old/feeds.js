#!/usr/bin/env node
/**
 * Compare BTC/USD from Pyth (Hermes SSE stream) vs Chainlink (on-chain AggregatorV3).
 * - Pyth: live server-sent events
 * - Chainlink: poll latestRoundData() every second via a public Ethereum RPC
 *
 * Usage:
 *   npm i eventsource ethers dotenv
 *   RPC_URL (optional) in .env for faster node; defaults to Cloudflare
 *   node compare-btc-feeds.js
 */

import 'dotenv/config';
import { EventSource } from 'eventsource';
import { ethers } from 'ethers';
import { createPublicClient, http, formatUnits, getAddress } from 'viem';
import { mainnet } from 'viem/chains';

// ---------- CONFIG ----------
const PYTH_PRICE_ID = '0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43'; // BTC/USD
const PYTH_SSE =
  `https://hermes.pyth.network/v2/updates/price/stream?ids[]=${PYTH_PRICE_ID}`;

// const CHAINLINK_AGG_ADDR = '0xF4030086522a5bEEA4988F8cA5B36dbC97BeE88c';
const CHAINLINK_AGG_ADDR = getAddress('0xF4030086522a5bEEA4988F8cA5B36dbC97BeE88c'); // BTC/USD
const RPC_URL = process.env.RPC_URL?.trim() || 'https://cloudflare-eth.com';
const CHAINLINK_POLL_MS = 1000;

// Pretty logger
function now() {
  return new Date().toISOString().replace('T', ' ').replace('Z', 'Z');
}
function fmt(n, dp = 2) {
  return Number(n).toFixed(dp);
}
function bps(a, b) {
  if (!a || !b) return 0;
  return ((a - b) / b) * 1e4;
}

// ---------- CHAINLINK (on-chain) ----------
// const ABI = [
//   'function decimals() view returns (uint8)',
//   'function latestRoundData() view returns (uint80,uint256,uint256,uint256,uint80)'
// ];
const ABI = [
  { type:'function', name:'decimals', stateMutability:'view', inputs:[], outputs:[{type:'uint8'}]},
  { type:'function', name:'latestRoundData', stateMutability:'view', inputs:[], outputs:[
    {type:'uint80'}, {type:'int256'}, {type:'uint256'}, {type:'uint256'}, {type:'uint80'}
  ]}
];

async function makeChainlinkReader() {
  const client = createPublicClient({
    chain: mainnet,
    transport: http(RPC_URL),
  });

  // sanity: this will throw if RPC isn’t mainnet-compatible
  const decimals = await client.readContract({
    address: CHAINLINK_AGG_ADDR,
    abi: ABI,
    functionName: 'decimals',
  });

  async function read() {
    const [, answer, , updatedAt] = await client.readContract({
      address: CHAINLINK_AGG_ADDR,
      abi: ABI,
      functionName: 'latestRoundData',
    });
    const price = Number(formatUnits(answer, decimals));
    return { price, updatedAt: Number(updatedAt) * 1000 };
  }

  return { read };

  // const provider = new ethers.JsonRpcProvider(RPC_URL, 1);  // <-- force chainId=1
  // const net = await provider.getNetwork();

  // console.log('[CHAINLINK] connected chainId =', Number(net.chainId), 'name =', net.name);

  // const agg = new ethers.Contract(CHAINLINK_AGG_ADDR, ABI, provider);
  // const decimals = await agg.decimals().catch(e => {
  //   console.error('[CHAINLINK] decimals() failed — is your RPC mainnet?', e.message);
  //   throw e;
  // });
  // console.log('[CHAINLINK] feed decimals =', decimals);

  // async function read() {
  //   const { answer, updatedAt } = await agg.latestRoundData();
  //   const price = Number(answer) / 10 ** decimals; // USD
  //   return { price, updatedAt: Number(updatedAt) * 1000 };
  // }

  // return { read };
}

// ---------- PYTH (Hermes SSE) ----------
function startPythStream(onPrice) {
  const es = new EventSource(PYTH_SSE);

  es.onopen = () => console.log(`[${now()}] Pyth: stream connected`);
  es.onerror = (e) => console.error(`[${now()}] Pyth: stream error`, e);

  let seen = 0; // debug: log first few events verbosely

  es.onmessage = (msg) => {
    const raw = msg.data;
    if (!raw || raw === 'ping' || raw === ': ping') return; // keepalives

    try {
      const payload = JSON.parse(raw);

      // Debug: show the first 3 messages to verify shape
      if (seen < 3) {
        console.log('[Pyth raw]', typeof payload, Array.isArray(payload) ? `array(len=${payload.length})` : 'object', raw.slice(0, 200));
        seen++;
      }

      // Helper: extract {price, tsMs} from any supported shape
      const tryEmit = (obj) => {
        if (!obj) return false;

        // Case A: direct { price: { feed_id, price, expo, publish_time } }
        if (obj.price && obj.price.feed_id?.toLowerCase() === PYTH_PRICE_ID.toLowerCase()) {
          const p = obj.price;
          const px = Number(p.price) * Math.pow(10, Number(p.expo)); // expo is negative
          const tsMs = Number(p.publish_time ?? p.timestamp ?? Math.floor(Date.now() / 1000)) * 1000;
          if (Number.isFinite(px)) { onPrice({ price: px, ts: tsMs }); return true; }
        }

        // Case B: { updates: [ { price: {...} }, ... ] }
        if (Array.isArray(obj.updates)) {
          let emitted = false;
          for (const u of obj.updates) emitted = tryEmit(u) || emitted;
          return emitted;
        }

        // Case C: array at top-level
        if (Array.isArray(obj)) {
          let emitted = false;
          for (const u of obj) emitted = tryEmit(u) || emitted;
          return emitted;
        }

        return false;
      };

      // Try payload directly
      if (!tryEmit(payload)) {
        // Some Hermes variants wrap in { data: [...] } or { parsed: [...] }
        if (!tryEmit(payload?.data) && !tryEmit(payload?.parsed)) {
          // If you see this line, paste the [Pyth raw] logs so we can tailor the parser
          // console.log('[Pyth] Unrecognized payload shape');
        }
      }
    } catch {
      // Non-JSON keepalives are normal; ignore
    }
  };

  return es;
}

// ---------- MAIN ----------
(async () => {
  let pythLast = null;

  // Start Pyth SSE
  startPythStream(({ price, ts }) => {
    pythLast = { price, ts };
  });

  // Start Chainlink on-chain poll
  const cl = await makeChainlinkReader();

  // Header
  console.log('timestamp\t\t\tpyth\t\tchainlink\tΔ (bps)');
  console.log('------------------------------------------------------------------');

  async function tick() {
    try {
      const clres = await cl.read();
      const clPx = clres.price;

      const pythPx = pythLast?.price || null;

      if (pythPx && clPx) {
        const deltaBps = bps(pythPx, clPx);
        console.log(
          `${now()}\t${fmt(pythPx, 2)}\t\t${fmt(clPx, 2)}\t\t${fmt(deltaBps, 1)}`
        );
      } else {
        console.log(`${now()}\tPyth:${pythPx ?? '—'}\tChainlink:${clPx ?? '—'}`);
      }
    } catch (e) {
      console.error(`[${now()}] tick error`, e?.message || e);
    } finally {
      setTimeout(tick, CHAINLINK_POLL_MS);
    }
  }
  tick();
})();

// ---------- OPTIONAL: Chainlink Data Streams (stub) ----------
/*
 * If you have Streams credentials, replace the on-chain reader with a REST/WS client here.
 * Typical auth involves X-Chainlink-Access-Key, Timestamp, and HMAC signature over the request.
 * Pseudocode:
 *
 * import crypto from 'crypto';
 * async function chainlinkStreamsLatest(streamId='btc-usd') {
 *   const accessKey = process.env.CHL_ACCESS_KEY;
 *   const secret = process.env.CHL_SECRET;
 *   const ts = Math.floor(Date.now()/1000).toString();
 *   const body = JSON.stringify({ stream_id: streamId });
 *   const path = '/v1/reports/latest';
 *   const toSign = `${ts}:${'POST'}:${path}:${body}`;
 *   const sig = crypto.createHmac('sha256', secret).update(toSign).digest('hex');
 *   const res = await fetch('https://api.dataengine.chain.link' + path, {
 *     method: 'POST',
 *     headers: {
 *       'Content-Type': 'application/json',
 *       'X-Chainlink-Access-Key': accessKey,
 *       'X-Chainlink-Timestamp': ts,
 *       'X-Chainlink-Signature': sig
 *     },
 *     body
 *   });
 *   const json = await res.json();
 *   // parse json.report.value, json.report.timestamp, etc.
 *   return { price, tsMs };
 * }
 */
