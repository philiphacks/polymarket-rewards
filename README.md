# Polymarket - Market Making & Farming

## Main Strategy

### Main.js:
The main strategy farms the /rewards page and adds YES & NO bids within the midpoint range at the most conservative spread.

Hedging has to be done manually, e.g. if you get filled on a YES for X shares, you have to calculate the Y share amount for NO to buy (in order to hedge).

Go to https://polymarket.com/rewards?onlyOpenOrders=true&id=earning_percentage&desc=true&q= to see earnings.

NOTE: THIS STRATEGY LOSES MONEY

### Crypto.js:

Very opportunistically posts bids to buy UP/DOWN on 15-min crypto markets (only on Bitcoin 15-min atm).


## Tweets & Interesting Links

https://x.com/Marko_Poly/status/1988353305785802863
https://polymarket.com/@Halfapound?via=marko_poly

## Deployed on DO Droplet

`ssh root@178.62.213.122`

Run with
`pm2 start crypto.js --name polymarket-bot`
`pm2 start altcrypto.js --name altpolymarket-bot`
`pm2 start history.js --name prices-bot`

Stop
`pm2 stop polymarket-bot`
`pm2 stop prices-bot`
`pm2 stop altpolymarket-bot`

or if that doesn't work use `pm2 list` and use `pm2 stop <ID>`.


# Tuning the Polymarket 15-Minute Crypto Bot

Right now the script is extremely conservative: multiple filters all have to agree before a trade happens. That’s why you’re seeing ~1 decent trade/hour plus the occasional tiny $20 @ 0.99 fill.

This note explains:

- What in the code is killing trade frequency  
- Which parameters to loosen (and in what order)  
- How to deal with the annoying small 0.99 fills  
- A small bug to fix in your position tracking  

---

## 1. What’s currently throttling trades

You’ve stacked several strong filters on top of each other.

### 1.1 Time gate

~~~js
if (
  minsLeft > 5 ||                        // too early, always skip
  (minsLeft > MINUTES_LEFT && minsLeft <= 5 && absZ < Z_HUGE) || // 3–5m, z not huge
  (minsLeft <= MINUTES_LEFT && absZ < zMaxDynamic)               // ≤3m, z not big enough
) {
  // skip
}
~~~

With:

~~~js
const MINUTES_LEFT = 3;
const Z_HUGE = 3.0;
~~~

This means:

- **No trades at all** when `minsLeft > 5`.  
- In the **3–5 minute window**, you only trade if `|z| >= 3` (very rare).  
- In the **last 3 minutes**, you only trade if `|z| >= zMaxDynamic` (≈ 1.7–2.5).

So you’ve restricted trades to a tiny slice of time *and* require relatively big z-scores inside that slice.

---

### 1.2 Directional z filter

~~~js
const Z_MIN = 0.5;

if (z >= Z_MIN && upAsk != null) {
  // candidate UP
}

if (z <= -Z_MIN && downAsk != null) {
  // candidate DOWN
}
~~~

- You only consider **Up** if price moved up at least `0.5σ`.  
- You only consider **Down** if it moved down at least `0.5σ`.

Situations where the price barely moved but the **order book is mispriced** are ignored.

---

### 1.3 EV threshold

~~~js
const MIN_EDGE_EARLY = 0.08;  // 8%
const MIN_EDGE_LATE  = 0.05;  // 5%

const minEdge = minsLeft > MINUTES_LEFT ? MIN_EDGE_EARLY : MIN_EDGE_LATE;
candidates = candidates.filter((c) => c.ev > minEdge);
~~~

- Need **≥ 8% edge** if `minsLeft > 3`.  
- Need **≥ 5% edge** if `minsLeft <= 3`.

That’s quite demanding given these markets are often semi-efficient.

---

### 1.4 Late-game layered orders also gated by EV

On top of that, your late-game (“hybrid layered”) orders have their own EV thresholds per layer (via `LAYER_MIN_EV`), which causes many potential layers to be skipped even when a side is strong.

Putting all of this together, **1 big trade/hour** is actually consistent with the current configuration.

---

## 2. Where to loosen first (in a sane order)

If you want more *good-size* trades (not just $20 @ 0.99), you should loosen constraints in this priority order:

1. Time gate  
2. EV thresholds  
3. Z-score thresholds  
4. Late-layer EV thresholds / sizing  

---

## 3. Loosen the time gate (biggest impact)

Instead of:

~~~js
if (
  minsLeft > 5 ||
  (minsLeft > MINUTES_LEFT && minsLeft <= 5 && absZ < Z_HUGE) ||
  (minsLeft <= MINUTES_LEFT && absZ < zMaxDynamic)
) {
  // skip
}
~~~

You can allow more activity by opening up the 3–7 minute window.

### Suggested replacement

~~~js
if (
  minsLeft > 7 ||  // **NEW**: completely ignore >7m, but allow 3–7m
  (minsLeft <= 7 && minsLeft > MINUTES_LEFT && absZ < zMaxDynamic) ||  // 3–7m: need |z| ≥ zMaxDynamic
  (minsLeft <= MINUTES_LEFT && absZ < 0.8 * zMaxDynamic)              // 0–3m: slightly softer threshold
) {
  // skip
}
~~~

Effect:

- Still **no trades** when `minsLeft > 7` (you avoid holding for ages).  
- From **7 → 3 minutes**, you can trade whenever `|z|` is already large (`≥ zMaxDynamic`).  
- In the **last 3 minutes**, you require slightly smaller `|z|` (`≥ 0.8 * zMaxDynamic`), increasing trade frequency when things spike late.

Alternatively, if you want something simpler:

- Just **delete the `absZ < Z_HUGE` clause** and rely on `zMaxDynamic` + EV.  
- Keep `minsLeft > 5` as “no trade” if you still dislike holding >5 minutes.

---

## 4. Lower the EV thresholds (more realistic edges)

Currently:

~~~js
const MIN_EDGE_EARLY = 0.08;  // 8%
const MIN_EDGE_LATE  = 0.05;  // 5%
~~~

You can let more trades through with:

~~~js
const MIN_EDGE_EARLY = 0.05;  // 5%
const MIN_EDGE_LATE  = 0.03;  // 3%
~~~

This does **not** make you reckless, it just:

- Allows late-window setups where you see EV ~0.04–0.06 that are now being filtered out.  
- Matches better with realistic edges in an active prediction market.

---

## 5. Soften z-score thresholds

Two key knobs:

### 5.1 Directional `Z_MIN`

~~~js
// from:
const Z_MIN = 0.5;

// to something like:
const Z_MIN = 0.35;  // or 0.3
~~~

This means:

- You start considering buy-Up or buy-Down candidates even when the move is only 0.3–0.35σ.  
- EV + time filters will still kill weak setups, but you’ll see more candidates.

---

### 5.2 `dynamicZMax` parameters

You currently have:

~~~js
const Z_MAX_FAR_MINUTES = 6;
const Z_MAX_NEAR_MINUTES = 3;
const Z_MAX_FAR = 2.5;
const Z_MAX_NEAR = 1.7;
~~~

You can make the “big enough z” requirement more permissive:

~~~js
const Z_MAX_FAR = 2.0;
const Z_MAX_NEAR = 1.4;
~~~

This lowers `zMaxDynamic`, so your late-game “z big enough” condition is satisfied more often, increasing trade frequency in both the 3–7 minute and 0–3 minute bands (depending on your time gate).

---

## 6. Adjust late-layer EV thresholds and 0.99c fills

You’re using a layered approach like:

~~~js
const LAYER_OFFSETS = [-0.03, -0.02, -0.01, 0.0];
const LAYER_SIZES   = [40, 40, 20, 10];
const LAYER_MIN_EV  = [0.015, 0.010, 0.005, 0.000]; // example you tried
~~~

### 6.1 If trades are still too rare in late-game

You can:

- Keep `LAYER_MIN_EV` as something like:

  ~~~js
  const LAYER_MIN_EV = [0.010, 0.007, 0.003, 0.000];
  ~~~

- Or reduce the number of layers and bump sizes:

  ~~~js
  const LAYER_OFFSETS = [-0.03, -0.02, -0.01];
  const LAYER_SIZES   = [60, 40, 20];
  const LAYER_MIN_EV  = [0.010, 0.005, 0.000];
  ~~~

This will:

- Try harder to get filled slightly inside the current ask.  
- Still avoid placing big size when EV is clearly negative.

---

### 6.2 Dealing with annoying $20 @ 0.99 trades

Those “tiny 0.99c” trades are coming from your last layer:

~~~js
const LAYER_OFFSETS = [-0.03, -0.02, -0.01, 0.0];
const LAYER_SIZES   = [40, 40, 20, 10];   // that 10 often hits near 0.99
~~~

If you dislike that:

1. **Drop the last layer entirely:**

   ~~~js
   const LAYER_OFFSETS = [-0.03, -0.02, -0.01];
   const LAYER_SIZES   = [60, 40, 20];
   ~~~

2. Or **cap the max price per layer** so you never bid 0.99:

   ~~~js
   let target = sideAsk + LAYER_OFFSETS[i];
   target = Math.max(0.01, Math.min(target, 0.95)); // never bid above 0.95
   ~~~

That way you’re not taking ultra-high-risk 0.99c nibbles that don’t move the needle.

---

## 7. Bug: double-counting position updates

At the end of your normal EV-based block you have:

~~~js
console.log(
  `[${asset.symbol}] >>> SIGNAL: BUY ${best.side} @ ${best.ask.toFixed(
    3
  )}, EV=${best.ev.toFixed(4)}, size=${size}`
);

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

console.log(`[${asset.symbol}] ORDER RESP:`, resp);
const currentShares = state.sharesBoughtBySlug[slug] || 0;
state.sharesBoughtBySlug[slug] = currentShares + size;
addPosition(state, slug, best.side, size);
addPosition(state, slug, best.side, size);
~~~

You’re calling `addPosition` **twice**, which:

- Doubles the recorded net exposure in `sideSharesBySlug`.  
- Pollutes `getExistingSide` and `canPlaceOrder` (hedge vs risk logic) for future markets.

Fix:

~~~js
console.log(
  `[${asset.symbol}] >>> SIGNAL: BUY ${best.side} @ ${best.ask.toFixed(
    3
  )}, EV=${best.ev.toFixed(4)}, size=${size}`
);

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

console.log(`[${asset.symbol}] ORDER RESP:`, resp);
const currentShares = state.sharesBoughtBySlug[slug] || 0;
state.sharesBoughtBySlug[slug] = currentShares + size;
addPosition(state, slug, best.side, size);  // only once
~~~

---

## 8. Practical tuning strategy

To avoid going full degen and to keep the bot debuggable:

1. **Change only 1–2 knobs at a time**, for example:  
   - Open time gate to trade from `minsLeft <= 7`.  
   - Lower `MIN_EDGE_EARLY` to `0.06`, `MIN_EDGE_LATE` to `0.03`.  

2. Let it run for a while and watch:  
   - Trades per hour.  
   - Logged EV at entry.  
   - Win rate / PnL per EV bucket (later, you can log the realized outcome vs EV).  

3. If realized edge looks good even in the 3–5% EV bucket, you can consider:  
   - Lowering thresholds a bit more.  
   - Slightly increasing order sizes for higher-EV tiers.  

A reasonable next step configuration might be:

- **Time gate**:  
  - Ignore `minsLeft > 7`.  
  - Use the revised compound condition as in section 3.  

- **Z thresholds**:  
  - `Z_MIN = 0.35`  
  - `Z_MAX_FAR = 2.0`, `Z_MAX_NEAR = 1.4`  

- **EV thresholds**:  
  - `MIN_EDGE_EARLY = 0.05`  
  - `MIN_EDGE_LATE = 0.03`  

- **Late layers**:  
  - Clamp `target <= 0.95`.  
  - Use `LAYER_MIN_EV` like `[0.010, 0.005, 0.000]`.  

That should give you **meaningfully more trades per hour** while still being fairly conservative and keeping individual losses under control.


# Minimum Data Set Size

For a high-frequency strategy like the Moneytron (15-minute expiries), **"Number of Days" matters less than "Variety of Regimes."**

Trading 30 days of a flat "crab" market will not tell you if your bot survives a flash crash. Conversely, testing only on a pump day will give you a false sense of confidence about your win rate.

Here is the breakdown of how much data you need and **why**.

### 1. The Minimum Viable Dataset: **7 Days (Include a Weekend)**
Since you are trading 15-minute markets across 4 assets, you get a massive number of observations quickly.
*   4 Assets $\times$ 96 Markets/Day = **384 Market Cycles per Day**.
*   In 7 days, that is **~2,688 Market Cycles**.

**Why 7 Days?**
*   **The Weekend Factor:** Crypto liquidity drops significantly on Sat/Sun. Spreads widen, and volatility dampens. Your "Low Volatility" logic (`regimeScalar < 1.2`) needs to be stress-tested here.
*   **The Weekday Factor:** You need Tuesday/Wednesday trading hours (US Open/Close) to test high-volume execution and "slam" windows.

### 2. The Ideal Robust Dataset: **14 to 21 Days**
This is the "Sweet Spot" for HFT optimization.

**Why? Statistical Significance in Buckets.**
Recall our `runDeepAnalysis` output. We split trades into buckets (e.g., `0.85-0.90` probability).
*   In your 1-day test, you had ~300 trades in one bucket. That is decent.
*   However, specific edge cases like **"Late Game (2m left) + SOL + High Volatility"** might only happen 3 times a day.
*   To trust your `Z_MIN_LATE` settings, you need at least **100 trades** in that specific, dangerous sub-bucket. Two to three weeks gets you there.

### 3. The "Regime" Checklist
Do not just pick the last 14 days sequentially. If the last 14 days were all bullish, your data is biased. Ensure your logs cover these four scenarios:

1.  **The Grind (Low Vol):** Price ranges <1% for 12 hours. (Tests your fee/spread efficiency).
2.  **The Pump/Dump (High Vol):** BTC moves >3% in an hour. (Tests your `Z_MAX` / counter-trend safety).
3.  **The Mean Reversion (Chop):** Price spikes up and immediately comes back down. (This is where Moneytron makes the most money).
4.  **The Trend (Drift):** Price goes up, pauses, goes up, pauses. (This is where Moneytron loses money by betting on reversion that never comes).

### How to Manage the Data
Since you are logging to `jsonl` files, these get large fast.

**Do not run one massive `backtest.js` on a 1GB file.** Node.js will run out of memory or become slow.

**Recommended Workflow:**
1.  **Log Daily:** Keep your `ticks-YYYYMMDD.jsonl` separate.
2.  **Analyze Weekly:** Create a script to run the backtest on 7 files sequentially and aggregate the `totalPnL` and `winRate`.
3.  **Targeted Forensics:** If you lose money on a specific day, run the backtest on *just that day* with `verbose: true` to see exactly why.

### Summary
*   **Current Status:** 1-3 days is enough to verify the code works and the logic is sound (Alpha check).
*   **Optimization Phase:** Collect **1 full week** (including Sat/Sun) before increasing your position size significantly.
*   **Final Form:** Keep a rolling window of the last **14 days** to constantly retune your `MIN_VOL_BPS` floors as the market personality changes.


