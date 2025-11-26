# 🔍 QUICK REFERENCE: v2.1 → v2.3 Code Changes

**Use this for quick code review and verification**

---

## 📌 SUMMARY: 12 CHANGES

| # | Change | Lines | Priority |
|---|--------|-------|----------|
| 1 | Version header | 1-8 | Info |
| 2 | Removed Z_MIN constants | 51-56 | Medium |
| 3 | Drift clamping | 155-162 | Medium |
| 4 | Added entryZ to state | 635 | Critical |
| 5 | Store entry z-score | 805-810 | Critical |
| 6 | Consolidated thresholds | 812-855 | Critical |
| 7 | Signal decay gate | 869-887 | Low |
| 8 | Reversal detector | 919-937 | Critical |
| 9 | Signal-aware LATE_LAYER | 978-999 | Critical |
| 10 | zHugeDynamic capping | 1013 | Medium |
| 11 | LATE_LAYER threshold | 1024 | Low |
| 12 | Version string | 1333 | Info |

---

## 🎯 CRITICAL CHANGES (Must Verify)

### **CHANGE #4: Added entryZ to State**

**File:** refactored_v2.3.js  
**Line:** 635

```javascript
// v2.1:
stateBySymbol[asset.symbol] = {
  slug,
  cryptoPriceUrl: cryptoPriceUrl({ symbol: asset.symbol }),
  gammaUrl: `https://gamma-api.polymarket.com/markets/slug/${slug}`,
  sharesBoughtBySlug: { [slug]: 0 },
  sideSharesBySlug: { [slug]: { UP: 0, DOWN: 0 } },
  resetting: false,
  cpData: null,
  marketMeta: null,
  zHistory: []
};

// v2.3:
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
  entryZ: null,  // ← NEW
  weakSignalCount: 0,
  weakSignalHistory: []
};
```

---

### **CHANGE #5: Store Entry Z-Score**

**File:** refactored_v2.3.js  
**Lines:** 805-810 (NEW)

```javascript
// v2.1:
// (nothing here)

// v2.3:
// ==============================================
// NEW: Store Entry Z-Score for Signal Reversal Detection
// ==============================================

if (state.entryZ === null && (sharesUp > 0 || sharesDown > 0)) {
  state.entryZ = z;
  logger.log(`[Entry Signal] Stored z=${z.toFixed(2)}`);
}
```

**Test:** Check logs for `[Entry Signal] Stored z=...` when first entering position

---

### **CHANGE #6: Consolidated Threshold Logic**

**File:** refactored_v2.3.js  
**Lines:** 812-855

**v2.1 (BUGGY - Set twice):**
```javascript
// First setting (line 855)
if (ENABLE_EARLY_TRADING && !isUSTradingHours()) {
  if (minsLeft > 8) {
    effectiveZMin = Z_MIN_SUPER_EARLY; // 2.0 - NOT regime adjusted!
  } else if (minsLeft > 5) {
    effectiveZMin = Z_MIN_VERY_EARLY; // 1.8 - NOT regime adjusted!
  } else if (minsLeft > 3) {
    effectiveZMin = Z_MIN_MID_EARLY; // 1.4 - NOT regime adjusted!
  } else if (minsLeft > 2) {
    effectiveZMin = 1.2 * regimeScalar; // TOO HIGH
  } else {
    effectiveZMin = Z_MIN_LATE * regimeScalar;
  }
} else {
  // ... other branches ...
}

// Then set AGAIN (line 999)
if (ENABLE_EARLY_TRADING && minsLeft > 5) {
  if (minsLeft > 8) {
    effectiveZMin = Z_MIN_SUPER_EARLY; // DUPLICATE!
  }
}
```

**v2.3 (FIXED - Set once with regime scaling):**
```javascript
// ==============================================
// Time-Based Z-Threshold (SET ONCE)
// ==============================================

const absZ = Math.abs(z);
let effectiveZMin;

if (ENABLE_EARLY_TRADING && !isUSTradingHours()) {
  // Early trading enabled (non-US hours)
  if (minsLeft > 8) {
    effectiveZMin = 1.9 * regimeScalar; // ← FIXED: Regime-adjusted, slightly lower
  } else if (minsLeft > 5) {
    effectiveZMin = 1.6 * regimeScalar; // ← FIXED: Regime-adjusted
  } else if (minsLeft > 3) {
    effectiveZMin = 1.3 * regimeScalar; // ← FIXED: Regime-adjusted
  } else if (minsLeft > 2) {
    effectiveZMin = 0.9 * regimeScalar; // ← FIXED: Lowered from 1.2
  } else {
    effectiveZMin = 0.7 * regimeScalar;
  }
} else {
  // US hours or early trading disabled
  if (minsLeft > 5) {
    logger.log(`Skip: Early trading disabled or US hours`);
    return;
  } else if (minsLeft > 3) {
    effectiveZMin = 1.8 * regimeScalar;
  } else if (minsLeft > 2) {
    effectiveZMin = 0.9 * regimeScalar; // ← FIXED: Lowered from 1.0
  } else {
    effectiveZMin = 0.7 * regimeScalar;
  }
}

// Apply low-vol adjustment
if (rawRegimeScalar < 1.1 && minsLeft > 2) {
  effectiveZMin *= 0.85;
}
```

**Test:** 
- Verify threshold is set only once
- Check logs show correct threshold value
- Confirm 2-3 min trades happen (should be more frequent)

---

### **CHANGE #8: Large Signal Reversal Detector**

**File:** refactored_v2.3.js  
**Lines:** 919-937 (NEW)

```javascript
// v2.1:
// (nothing here - no reversal detection)

// v2.3:
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
      return; // ← EXITS ALL TRADING
    }
  }
}
```

**Test:** 
- Check logs for `⚠️  SIGNAL REVERSAL` messages
- Verify trading stops after reversal
- Should see ~0-2 reversals per day (losers prevented)

---

### **CHANGE #9: Signal-Aware LATE_LAYER**

**File:** refactored_v2.3.js  
**Lines:** 978-999

**v2.1 (BUGGY - Duplicate check):**
```javascript
// Line 1026: First reversal check (REACHABLE)
if (state.zHistory && state.zHistory.length >= 4) {
  // ... reversal detection ...
  if (reversalMagnitude > 1.5) {
    return; // ← EXITS HERE
  }
}

// Line 1048: LATE_LAYER section (UNREACHABLE if reversed)
if (absZ > zMaxTimeBased || minsLeft < 2) {
  // Duplicate reversal check that never executes!
  const entrySignal = state.entryZ || z;
  if (signalFlipped && largeReversal) {
    return; // ← NEVER REACHED
  }
}
```

**v2.3 (FIXED - Single check at LATE_LAYER entry):**
```javascript
// Line 919: First reversal check (REACHABLE)
// ... same as before ...

// Line 978: LATE_LAYER section (NOW ALSO CHECKS)
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
  // ... rest of LATE_LAYER code ...
}
```

**Note:** First check (line 919) catches reversals early. LATE_LAYER check is backup for edge cases.

**Test:**
- Check logs for `⛔ LATE_LAYER BLOCKED` messages
- Verify LATE_LAYER still works when signal consistent
- Should see LATE_LAYER blocked in ~6-7 losing trades

---

## 📊 VERIFICATION CHECKLIST

### **Before Deployment:**

**Code Review:**
- [ ] Line 635: entryZ added to state initialization
- [ ] Line 805-810: Entry z-score storage code present
- [ ] Line 812-855: Threshold logic consolidated and regime-adjusted
- [ ] Line 919-937: Reversal detector present
- [ ] Line 978-999: Signal-aware LATE_LAYER present
- [ ] No duplicate reversal checks (removed from old line 1048)

**Logic Verification:**
- [ ] effectiveZMin set only once (not twice)
- [ ] All thresholds multiplied by regimeScalar
- [ ] 2-3 min threshold is 0.9 (not 1.2)
- [ ] Reversal threshold is 1.5σ
- [ ] entryZ initialized as null

**Test Cases:**
- [ ] Entry z-score stored on first position
- [ ] Reversal detector triggers on >1.5σ flip
- [ ] LATE_LAYER blocked when signal reversed
- [ ] LATE_LAYER works when signal consistent
- [ ] Thresholds correct in high/low vol

---

### **During Paper Trading (24-48 hours):**

**Monitoring:**
- [ ] Check for `[Entry Signal]` in logs
- [ ] Check for `⚠️  SIGNAL REVERSAL` in logs
- [ ] Check for `⛔ LATE_LAYER BLOCKED` in logs
- [ ] Verify winners still happen (should be ~170/day)
- [ ] Verify losers reduced (should be ~1-2/day vs 7/day)
- [ ] No errors or crashes

**Red Flags:**
- ⚠️ Win rate drops below 95%
- ⚠️ No reversal detections (threshold too high?)
- ⚠️ Too many reversal detections (threshold too low?)
- ⚠️ LATE_LAYER never executes (signal check too strict?)
- ⚠️ Errors about undefined entryZ

---

### **After Production Deployment:**

**Day 1-2:**
- [ ] Monitor win rate hourly
- [ ] Check P&L vs expectations
- [ ] Verify reversal detections happening
- [ ] Look for any unexpected behavior

**Day 3-7:**
- [ ] Calculate win rate (target: >98%)
- [ ] Calculate avg loss (target: <$120)
- [ ] Calculate net P&L (target: >$150/day)
- [ ] Verify no winners blocked
- [ ] Verify losers reduced by >80%

---

## 🚨 ROLLBACK TRIGGERS

**Immediate rollback if:**
- Win rate drops below 90%
- Bot crashes or errors
- Winners being blocked (check logs)
- Loss per trade increases

**Consider rollback if:**
- Win rate drops below 95% for 2+ days
- Net P&L worse than v2.1 baseline
- Losers not reduced by at least 50%

---

## 📞 QUICK HELP

**Issue:** Entry z-score not stored
**Check:** Line 805, verify `state.entryZ === null` condition
**Fix:** Make sure entryZ initialized in state (line 635)

**Issue:** Reversals not detected
**Check:** Line 919, verify zHistory has 4+ entries
**Fix:** Lower 1.5σ threshold to 1.3σ

**Issue:** Too many reversals detected
**Check:** Line 930, verify 1.5σ threshold
**Fix:** Raise threshold to 1.8σ

**Issue:** LATE_LAYER never executes
**Check:** Line 978, verify signal check logic
**Fix:** Adjust 1.5σ threshold or check entryZ storage

**Issue:** Winners being blocked
**Check:** Lines 812-855, verify thresholds
**Fix:** Lower 0.9 threshold to 0.8

---

## 📋 DIFF SUMMARY

```diff
Version: 2.1 → 2.3

+ Added entry z-score storage (line 635, 805-810)
+ Added signal reversal detector (line 919-937)
+ Added signal-aware LATE_LAYER (line 978-999)
+ Added drift clamping (line 155-162)
- Removed Z_MIN constants (line 51-56)
- Removed duplicate threshold setting (line 999-1010)
- Removed duplicate reversal check (line 1048-1063)
~ Fixed regime scalar application (line 812-855)
~ Lowered 2-3 min threshold 1.2 → 0.9 (line 830)
~ Capped zHugeDynamic at 2.8 (line 1013)

Files changed: 1
Lines added: ~80
Lines removed: ~30
Net change: +50 lines
```

---

**Ready to verify? Start with the checklist above!** ✅
