# 🎯 BACKTESTER CONFIG QUICK REFERENCE

## 📊 RECOMMENDED CONFIGS TO TEST

---

## 🔴 CONFIG #1: BASELINE (Your Old Strategy)
```javascript
const CONFIG = {
  Z_MIN_VERY_EARLY: 1.8,
  Z_MIN_MID_EARLY: 1.4,
  Z_MIN_LATE_2TO3: 0.7,  // OLD VALUE
  Z_MIN_VERY_LATE: 0.7,
  
  ENABLE_EARLY_TRADING: false,
  USE_SIGNAL_DECAY_CHECK: false,
  USE_WEAK_SIGNAL_COUNTER: false,
  USE_EARLY_BASIS_RISK: false,
  USE_REGIME_SCALAR: false,
  USE_DRIFT: false,
};
```
**Purpose:** Establish baseline performance
**Expected:** Lower win rate, higher losses

---

## 🟡 CONFIG #2: JUST 2-3 MIN THRESHOLD FIX
```javascript
const CONFIG = {
  Z_MIN_VERY_EARLY: 1.8,
  Z_MIN_MID_EARLY: 1.4,
  Z_MIN_LATE_2TO3: 1.0,  // NEW!
  Z_MIN_VERY_LATE: 0.8,
  
  ENABLE_EARLY_TRADING: true,
  USE_SIGNAL_DECAY_CHECK: false,
  USE_WEAK_SIGNAL_COUNTER: false,
  USE_EARLY_BASIS_RISK: false,
  USE_REGIME_SCALAR: true,
  USE_DRIFT: true,
};
```
**Purpose:** Test impact of just the z-threshold fix
**Expected:** Blocks SOL loss, some improvement

---

## 🟢 CONFIG #3: CONSERVATIVE (Recommended Start)
```javascript
const CONFIG = {
  Z_MIN_VERY_EARLY: 1.8,
  Z_MIN_MID_EARLY: 1.4,
  Z_MIN_LATE_2TO3: 1.0,
  Z_MIN_VERY_LATE: 0.8,
  
  ENABLE_EARLY_TRADING: true,
  USE_SIGNAL_DECAY_CHECK: true,
  SIGNAL_DECAY_THRESHOLD_EARLY: 0.4,
  SIGNAL_DECAY_THRESHOLD_LATE: 0.25,
  
  USE_WEAK_SIGNAL_COUNTER: true,
  WEAK_SIGNAL_CONSECUTIVE_LIMIT: 3,
  WEAK_SIGNAL_RATIO_LIMIT: 6,
  
  USE_EARLY_BASIS_RISK: true,
  EARLY_BASIS_RISK_THRESHOLD_BPS: 20,
  
  USE_REGIME_SCALAR: true,
  REGIME_SCALAR_MIN: 0.7,
  REGIME_SCALAR_MAX: 1.4,
  
  USE_DRIFT: true,
};
```
**Purpose:** Full protection, conservative settings
**Expected:** Best risk-adjusted returns

---

## 🔵 CONFIG #4: AGGRESSIVE (More Trades)
```javascript
const CONFIG = {
  Z_MIN_VERY_EARLY: 1.6,  // Lower
  Z_MIN_MID_EARLY: 1.2,   // Lower
  Z_MIN_LATE_2TO3: 0.9,   // Lower
  Z_MIN_VERY_LATE: 0.7,   // Lower
  
  ENABLE_EARLY_TRADING: true,
  USE_SIGNAL_DECAY_CHECK: true,
  SIGNAL_DECAY_THRESHOLD_EARLY: 0.5,  // Higher (less sensitive)
  SIGNAL_DECAY_THRESHOLD_LATE: 0.35,  // Higher
  
  USE_WEAK_SIGNAL_COUNTER: true,
  WEAK_SIGNAL_CONSECUTIVE_LIMIT: 4,  // More tolerant
  WEAK_SIGNAL_RATIO_LIMIT: 7,        // More tolerant
  
  USE_EARLY_BASIS_RISK: true,
  EARLY_BASIS_RISK_THRESHOLD_BPS: 30,  // More tolerant
  
  USE_REGIME_SCALAR: true,
  USE_DRIFT: true,
};
```
**Purpose:** More trades, higher risk
**Expected:** Higher volume, possibly lower Sharpe

---

## 🟣 CONFIG #5: ULTRA CONSERVATIVE (Minimal Trades)
```javascript
const CONFIG = {
  Z_MIN_VERY_EARLY: 2.0,  // Higher
  Z_MIN_MID_EARLY: 1.6,   // Higher
  Z_MIN_LATE_2TO3: 1.2,   // Higher
  Z_MIN_VERY_LATE: 1.0,   // Higher
  
  ENABLE_EARLY_TRADING: true,
  USE_SIGNAL_DECAY_CHECK: true,
  SIGNAL_DECAY_THRESHOLD_EARLY: 0.3,  // Lower (more sensitive)
  SIGNAL_DECAY_THRESHOLD_LATE: 0.2,   // Lower
  
  USE_WEAK_SIGNAL_COUNTER: true,
  WEAK_SIGNAL_CONSECUTIVE_LIMIT: 2,  // Stricter
  WEAK_SIGNAL_RATIO_LIMIT: 5,        // Stricter
  
  USE_EARLY_BASIS_RISK: true,
  EARLY_BASIS_RISK_THRESHOLD_BPS: 15,  // Stricter
  
  USE_REGIME_SCALAR: true,
  USE_DRIFT: true,
};
```
**Purpose:** Only trade best opportunities
**Expected:** Very high win rate, low volume

---

## 📊 COMPARISON TEMPLATE

| Config | Trades | Win% | PnL | Volume | RoV | Max DD | Sharpe |
|--------|--------|------|-----|--------|-----|--------|--------|
| Baseline | ? | ? | ? | ? | ? | ? | ? |
| Z-Fix Only | ? | ? | ? | ? | ? | ? | ? |
| Conservative | ? | ? | ? | ? | ? | ? | ? |
| Aggressive | ? | ? | ? | ? | ? | ? | ? |
| Ultra Cons. | ? | ? | ? | ? | ? | ? | ? |

---

## 🎯 DECISION MATRIX

### **Choose CONSERVATIVE if:**
- ✅ You value capital preservation
- ✅ You want stable, consistent returns
- ✅ You can't monitor the bot constantly
- ✅ You're risk-averse

### **Choose AGGRESSIVE if:**
- ✅ You want maximum volume
- ✅ You can tolerate drawdowns
- ✅ You're actively monitoring
- ✅ You're risk-seeking

### **Choose ULTRA CONSERVATIVE if:**
- ✅ You only want slam-dunk trades
- ✅ You're testing new code
- ✅ You're using this for confidence building
- ✅ Capital preservation is paramount

---

## 🔍 WHAT TO OPTIMIZE FOR

### **Maximize Risk-Adjusted Returns:**
```
Goal: Highest (PnL / Max Drawdown) ratio
→ Use CONSERVATIVE config
→ Focus on Sharpe ratio
```

### **Maximize Absolute Returns:**
```
Goal: Highest total PnL
→ Use AGGRESSIVE config
→ Accept higher drawdowns
```

### **Maximize Win Rate:**
```
Goal: Highest % of winning trades
→ Use ULTRA CONSERVATIVE config
→ Accept lower volume
```

### **Maximize Return on Volume:**
```
Goal: Highest PnL per $ traded
→ Use CONSERVATIVE or ULTRA CONSERVATIVE
→ Only best opportunities
```

---

## 🎓 TUNING GUIDE

### **If Too Many Good Trades Blocked:**
- Lower Z_MIN_LATE_2TO3 (try 0.9)
- Increase SIGNAL_DECAY_THRESHOLD (try 0.35, 0.45)
- Increase WEAK_SIGNAL_CONSECUTIVE_LIMIT (try 4)

### **If Too Many Bad Trades Getting Through:**
- Raise Z_MIN_LATE_2TO3 (try 1.1)
- Decrease SIGNAL_DECAY_THRESHOLD (try 0.2, 0.3)
- Decrease WEAK_SIGNAL_CONSECUTIVE_LIMIT (try 2)

### **If Win Rate Too Low:**
- Check blocked trades - are you blocking good ones?
- Lower thresholds slightly
- Disable one feature at a time

### **If Drawdown Too High:**
- Check which trades lost the most
- Enable stricter risk controls
- Raise thresholds

---

## 📈 SUCCESS METRICS

### **Minimum Viable Performance:**
- Win Rate: >70%
- Max Drawdown: <15%
- Sharpe Ratio: >1.0
- Return on Volume: >5%

### **Good Performance:**
- Win Rate: >75%
- Max Drawdown: <12%
- Sharpe Ratio: >1.5
- Return on Volume: >8%

### **Excellent Performance:**
- Win Rate: >80%
- Max Drawdown: <10%
- Sharpe Ratio: >2.0
- Return on Volume: >10%

---

## 🚀 RECOMMENDED WORKFLOW

### **Day 1: Baseline**
```bash
# Run CONFIG #1 (Baseline)
node backtester_v2_upgraded.js > results_baseline.txt

# Save results
# Note: Total PnL, Win Rate, Max DD
```

### **Day 2: Conservative Test**
```bash
# Run CONFIG #3 (Conservative)
node backtester_v2_upgraded.js > results_conservative.txt

# Compare to baseline
# Check blocked trades - do they make sense?
```

### **Day 3: Optimization**
```bash
# Try CONFIG #2, #4, #5
# Create comparison table
# Choose best config for your risk tolerance
```

### **Day 4: Validation**
```bash
# Run chosen config on different date ranges
# Verify consistency
# Check for overfitting
```

### **Day 5: Deploy**
```bash
# Update live bot with chosen config
# Monitor first 10 trades closely
# Verify behavior matches backtest
```

---

## 🔚 FINAL CHECKLIST

Before deploying:
- [ ] Ran at least 3 different configs
- [ ] Conservative config shows improvement over baseline
- [ ] Blocked trades analysis makes sense
- [ ] SOL/BTC losses would have been prevented
- [ ] XRP wins preserved
- [ ] Win rate >70%
- [ ] Max drawdown <15%
- [ ] Verified on multiple date ranges
- [ ] Compared to live bot config

**If all checked → DEPLOY!** 🚀
