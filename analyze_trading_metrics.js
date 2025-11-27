#!/usr/bin/env node
/**
 * Trading Metrics Analyzer - Moneytron v2.4.1
 * Analyzes trading performance to determine when to enable early US hours trading
 * 
 * Usage:
 *   node analyze_trading_metrics.js [--days 14] [--output report.txt]
 * 
 * Analyzes:
 * - Win rates by time window (0-2, 2-3, 3-5, 5-10 mins)
 * - Exit effectiveness (success rate, recovery %)
 * - US vs Non-US performance comparison
 * - Recommendations for enabling early trading
 */

import fs from 'fs';
import path from 'path';

// ============================================
// CONFIGURATION
// ============================================

const CONFIG = {
  daysToAnalyze: 14,
  outputFile: 'trading_metrics_report.txt',
  
  // Time windows (minutes left)
  timeWindows: [
    { name: '0-2 mins', min: 0, max: 2, targetWinRate: 0.65 },
    { name: '2-3 mins', min: 2, max: 3, targetWinRate: 0.60 },
    { name: '3-5 mins', min: 3, max: 5, targetWinRate: 0.55 },
    { name: '5-10 mins', min: 5, max: 10, targetWinRate: 0.50 },
    { name: '10+ mins', min: 10, max: 999, targetWinRate: 0.50 }
  ],
  
  // Thresholds for enabling early trading
  thresholds: {
    minExitSuccessRate: 0.80,      // 80% of exits should work
    minExitRecovery: 0.50,          // 50% average recovery
    minWinRate: 0.50,               // 50% win rate in new window
    maxWinRateGap: 0.05,            // US vs non-US gap < 5%
    minTrades: 20                   // Min trades in window to evaluate
  }
};

// ============================================
// DATA STRUCTURES
// ============================================

class TradeAnalyzer {
  constructor() {
    this.orders = [];
    this.exits = [];
    this.trades = new Map(); // slug+timestamp -> trade info
  }

  /**
   * Load all order files from ./files/ directory
   */
  loadOrderFiles(daysBack = 14) {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysBack);
    
    const filesDir = './files';
    if (!fs.existsSync(filesDir)) {
      throw new Error(`Directory ${filesDir} not found. Make sure your log files are in ./files/`);
    }
    
    const files = fs.readdirSync(filesDir)
      .filter(f => f.startsWith('orders-') && f.endsWith('.jsonl'));
    
    console.log(`Found ${files.length} order log files in ${filesDir}`);
    
    for (const file of files) {
      // Extract date from filename: orders-2024-11-27.jsonl
      const dateMatch = file.match(/orders-(\d{4}-\d{2}-\d{2})/);
      if (!dateMatch) continue;
      
      const fileDate = new Date(dateMatch[1]);
      if (fileDate < cutoffDate) continue;
      
      const content = fs.readFileSync(path.join(filesDir, file), 'utf-8');
      const lines = content.trim().split('\n').filter(l => l.length > 0);
      
      for (const line of lines) {
        try {
          const order = JSON.parse(line);
          
          if (order.type === 'EXIT') {
            this.exits.push(order);
          } else {
            this.orders.push(order);
          }
        } catch (err) {
          console.error(`Error parsing line in ${file}:`, err.message);
        }
      }
    }
    
    console.log(`Loaded ${this.orders.length} orders, ${this.exits.length} exits`);
  }

  /**
   * Match orders with their outcomes from tick logs
   */
  async matchOrderOutcomes() {
    // Load tick logs to determine outcomes
    const filesDir = './files';
    const tickFiles = fs.readdirSync(filesDir)
      .filter(f => f.startsWith('ticks-') && f.endsWith('.jsonl'));
    
    const ticksBySlug = new Map();
    
    for (const file of tickFiles) {
      const content = fs.readFileSync(path.join(filesDir, file), 'utf-8');
      const lines = content.trim().split('\n').filter(l => l.length > 0);
      
      for (const line of lines) {
        try {
          const tick = JSON.parse(line);
          if (!ticksBySlug.has(tick.slug)) {
            ticksBySlug.set(tick.slug, []);
          }
          ticksBySlug.get(tick.slug).push(tick);
        } catch (err) {
          // Skip bad lines
        }
      }
    }
    
    // Sort ticks by timestamp for each slug
    for (const [slug, ticks] of ticksBySlug.entries()) {
      ticks.sort((a, b) => a.ts - b.ts);
    }
    
    console.log(`Loaded ticks for ${ticksBySlug.size} market intervals`);
    
    // Match each order to outcome
    for (const order of this.orders) {
      const ticks = ticksBySlug.get(order.slug);
      if (!ticks) continue;
      
      // Find interval end (minsLeft ~= 0)
      const endTick = ticks.find(t => t.minsLeft < 0.05);
      if (!endTick) continue;
      
      // Determine outcome
      const won = (order.side === 'UP' && endTick.currentPrice > endTick.startPrice) ||
                  (order.side === 'DOWN' && endTick.currentPrice < endTick.startPrice);
      
      // Calculate minutes left at order time
      // Find tick closest to order time
      let closestTick = ticks[0];
      for (const tick of ticks) {
        if (Math.abs(tick.ts - order.ts) < Math.abs(closestTick.ts - order.ts)) {
          closestTick = tick;
        }
      }
      
      const minsLeft = closestTick.minsLeft || 0;
      const isUS = order.session === 'US';
      
      this.trades.set(order.orderID, {
        ...order,
        won,
        minsLeft,
        isUS,
        pnl: won ? (order.size * (1 - order.price)) : (-order.size * order.price)
      });
    }
    
    console.log(`Matched ${this.trades.size} trades with outcomes`);
  }

  /**
   * Calculate metrics by time window
   */
  calculateTimeWindowMetrics() {
    const metrics = {
      overall: {},
      us: {},
      nonUS: {}
    };
    
    for (const window of CONFIG.timeWindows) {
      const allTrades = Array.from(this.trades.values())
        .filter(t => t.minsLeft >= window.min && t.minsLeft < window.max);
      
      const usTrades = allTrades.filter(t => t.isUS);
      const nonUSTrades = allTrades.filter(t => !t.isUS);
      
      metrics.overall[window.name] = this.calculateStats(allTrades, window);
      metrics.us[window.name] = this.calculateStats(usTrades, window);
      metrics.nonUS[window.name] = this.calculateStats(nonUSTrades, window);
    }
    
    return metrics;
  }

  /**
   * Calculate statistics for a set of trades
   */
  calculateStats(trades, window) {
    if (trades.length === 0) {
      return {
        count: 0,
        winRate: 0,
        avgPnL: 0,
        totalPnL: 0,
        targetWinRate: window.targetWinRate,
        meetsTarget: false,
        confidence: 'insufficient_data'
      };
    }
    
    const wins = trades.filter(t => t.won).length;
    const winRate = wins / trades.length;
    const totalPnL = trades.reduce((sum, t) => sum + t.pnl, 0);
    const avgPnL = totalPnL / trades.length;
    
    const meetsTarget = winRate >= window.targetWinRate;
    
    let confidence = 'low';
    if (trades.length >= 50) confidence = 'high';
    else if (trades.length >= 20) confidence = 'medium';
    
    return {
      count: trades.length,
      wins,
      losses: trades.length - wins,
      winRate,
      avgPnL,
      totalPnL,
      targetWinRate: window.targetWinRate,
      meetsTarget,
      confidence,
      gap: winRate - window.targetWinRate
    };
  }

  /**
   * Analyze exit effectiveness
   */
  analyzeExitEffectiveness() {
    if (this.exits.length === 0) {
      return {
        totalExits: 0,
        successRate: 0,
        avgRecovery: 0,
        meetsThreshold: false
      };
    }
    
    // Count successful exits (ones that got filled)
    // We can infer success if there's a corresponding state change
    // For now, assume all logged exits attempted
    const successful = this.exits.filter(e => e.orderID).length;
    const successRate = successful / this.exits.length;
    
    // Calculate average recovery
    const recoveries = this.exits
      .filter(e => e.expectedRecovery && e.trackedShares)
      .map(e => {
        const invested = e.trackedShares * 0.95; // Assume avg entry ~95¢
        return e.expectedRecovery / invested;
      });
    
    const avgRecovery = recoveries.length > 0 
      ? recoveries.reduce((a, b) => a + b, 0) / recoveries.length 
      : 0;
    
    const meetsThreshold = successRate >= CONFIG.thresholds.minExitSuccessRate &&
                          avgRecovery >= CONFIG.thresholds.minExitRecovery;
    
    return {
      totalExits: this.exits.length,
      successful,
      successRate,
      avgRecovery,
      meetsThreshold,
      thresholds: {
        minSuccessRate: CONFIG.thresholds.minExitSuccessRate,
        minRecovery: CONFIG.thresholds.minExitRecovery
      }
    };
  }

  /**
   * Generate recommendations
   */
  generateRecommendations(metrics, exitMetrics) {
    const recommendations = {
      phase: 'current',
      readyForNext: false,
      reasoning: [],
      nextSteps: [],
      warnings: []
    };
    
    // Check prerequisites
    const exitReady = exitMetrics.meetsThreshold;
    const lateGameUS = metrics.us['0-2 mins'];
    const lateGameUSReady = lateGameUS.meetsTarget && lateGameUS.confidence !== 'low';
    
    if (!exitReady) {
      recommendations.phase = 'phase_1_validation';
      recommendations.reasoning.push(
        '❌ Exit mechanism not yet validated',
        `   Success rate: ${(exitMetrics.successRate * 100).toFixed(1)}% (need ${(CONFIG.thresholds.minExitSuccessRate * 100).toFixed(0)}%)`,
        `   Avg recovery: ${(exitMetrics.avgRecovery * 100).toFixed(1)}% (need ${(CONFIG.thresholds.minExitRecovery * 100).toFixed(0)}%)`
      );
      recommendations.nextSteps.push(
        'Continue running with current settings for 1-2 more weeks',
        'Monitor exit logs for "ULTRA-LATE EXIT" and "EXIT CONDITION MET"',
        'Ensure exits are executing successfully'
      );
      return recommendations;
    }
    
    recommendations.reasoning.push('✅ Exit mechanism validated');
    
    if (!lateGameUSReady) {
      recommendations.phase = 'phase_1_validation';
      recommendations.reasoning.push(
        '⚠️  US late-game performance needs more data',
        `   Win rate: ${(lateGameUS.winRate * 100).toFixed(1)}% (need ${(lateGameUS.targetWinRate * 100).toFixed(0)}%)`,
        `   Trades: ${lateGameUS.count} (need ${CONFIG.thresholds.minTrades})`
      );
      recommendations.nextSteps.push(
        'Continue trading US hours 0-4 mins only',
        'Need more late-game trades to establish baseline'
      );
      return recommendations;
    }
    
    recommendations.reasoning.push('✅ US late-game performance stable');
    
    // Check if ready for Phase 2 (4-5 mins)
    const nonUS_4_5 = metrics.nonUS['3-5 mins'];
    const us_4_5 = metrics.us['3-5 mins'];
    
    if (nonUS_4_5.count >= CONFIG.thresholds.minTrades && 
        nonUS_4_5.meetsTarget) {
      
      recommendations.phase = 'phase_2_ready';
      recommendations.readyForNext = true;
      recommendations.reasoning.push(
        '✅ Non-US 4-5 min window performing well',
        `   Win rate: ${(nonUS_4_5.winRate * 100).toFixed(1)}%`,
        '✅ Ready to test US 4-5 mins'
      );
      recommendations.nextSteps.push(
        'Enable US 4-5 min trading with strict 1.8σ threshold',
        'Monitor for 20+ trades in this window',
        'Target: >50% win rate in 4-5 min US window'
      );
      
      // If already has US 4-5 data, check if ready for Phase 3
      if (us_4_5.count >= CONFIG.thresholds.minTrades) {
        const gap = Math.abs(us_4_5.winRate - nonUS_4_5.winRate);
        
        if (us_4_5.meetsTarget && gap <= CONFIG.thresholds.maxWinRateGap) {
          recommendations.phase = 'phase_3_ready';
          recommendations.reasoning.push(
            '✅ US 4-5 min window validated',
            `   Win rate: ${(us_4_5.winRate * 100).toFixed(1)}% vs non-US ${(nonUS_4_5.winRate * 100).toFixed(1)}%`,
            `   Gap: ${(gap * 100).toFixed(1)}% (< ${(CONFIG.thresholds.maxWinRateGap * 100).toFixed(0)}% threshold)`
          );
          recommendations.nextSteps = [
            'Enable US 5-6 min trading with 2.0σ threshold',
            'Continue monitoring all windows',
            'After 20+ trades, evaluate for Phase 4'
          ];
        } else {
          recommendations.warnings.push(
            `⚠️  US 4-5 min performance below target`,
            `   Win rate: ${(us_4_5.winRate * 100).toFixed(1)}% (need ${(us_4_5.targetWinRate * 100).toFixed(0)}%)`,
            `   Gap: ${(gap * 100).toFixed(1)}% (max ${(CONFIG.thresholds.maxWinRateGap * 100).toFixed(0)}%)`
          );
          recommendations.nextSteps = [
            'Continue US 4-5 min trading for more data',
            'Review losing trades in this window',
            'Consider adjusting threshold if consistently underperforming'
          ];
        }
      }
    } else {
      recommendations.phase = 'phase_1_validation';
      recommendations.reasoning.push(
        '⚠️  Non-US 4-5 min window needs validation',
        `   Win rate: ${(nonUS_4_5.winRate * 100).toFixed(1)}% (need ${(nonUS_4_5.targetWinRate * 100).toFixed(0)}%)`,
        `   Trades: ${nonUS_4_5.count} (need ${CONFIG.thresholds.minTrades})`
      );
      recommendations.nextSteps.push(
        'Continue current settings',
        'Non-US early trading (4-5 mins) needs more data first',
        'Cannot expand to US hours without non-US baseline'
      );
    }
    
    return recommendations;
  }
}

// ============================================
// REPORT GENERATION
// ============================================

function generateReport(metrics, exitMetrics, recommendations) {
  const lines = [];
  const hr = '='.repeat(80);
  
  lines.push(hr);
  lines.push('MONEYTRON TRADING METRICS REPORT');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Analysis Period: Last ${CONFIG.daysToAnalyze} days`);
  lines.push(hr);
  lines.push('');
  
  // Exit Effectiveness
  lines.push('━'.repeat(80));
  lines.push('📊 EXIT MECHANISM EFFECTIVENESS');
  lines.push('━'.repeat(80));
  lines.push('');
  lines.push(`Total Exits Attempted: ${exitMetrics.totalExits}`);
  lines.push(`Successful: ${exitMetrics.successful} (${(exitMetrics.successRate * 100).toFixed(1)}%)`);
  lines.push(`Target: >${(CONFIG.thresholds.minExitSuccessRate * 100).toFixed(0)}%`);
  lines.push('');
  lines.push(`Average Recovery: ${(exitMetrics.avgRecovery * 100).toFixed(1)}%`);
  lines.push(`Target: >${(CONFIG.thresholds.minExitRecovery * 100).toFixed(0)}%`);
  lines.push('');
  lines.push(`Status: ${exitMetrics.meetsThreshold ? '✅ PASSING' : '❌ NEEDS IMPROVEMENT'}`);
  lines.push('');
  
  // Time Window Performance
  lines.push('━'.repeat(80));
  lines.push('📈 TIME WINDOW PERFORMANCE');
  lines.push('━'.repeat(80));
  lines.push('');
  
  for (const window of CONFIG.timeWindows) {
    const overall = metrics.overall[window.name];
    const us = metrics.us[window.name];
    const nonUS = metrics.nonUS[window.name];
    
    lines.push(`${window.name.toUpperCase()}`);
    lines.push('─'.repeat(80));
    
    // Overall
    lines.push(`Overall: ${overall.count} trades | Win Rate: ${(overall.winRate * 100).toFixed(1)}% | Target: ${(overall.targetWinRate * 100).toFixed(0)}% | ${overall.meetsTarget ? '✅' : '❌'}`);
    lines.push(`  Wins: ${overall.wins} | Losses: ${overall.losses} | Confidence: ${overall.confidence.toUpperCase()}`);
    lines.push(`  PnL: $${overall.totalPnL.toFixed(2)} | Avg: $${overall.avgPnL.toFixed(2)}`);
    lines.push('');
    
    // US vs Non-US comparison
    if (us.count > 0 && nonUS.count > 0) {
      const gap = Math.abs(us.winRate - nonUS.winRate);
      lines.push(`  US Hours:     ${us.count.toString().padEnd(3)} trades | Win Rate: ${(us.winRate * 100).toFixed(1).padStart(5)}% | ${us.meetsTarget ? '✅' : '❌'}`);
      lines.push(`  Non-US Hours: ${nonUS.count.toString().padEnd(3)} trades | Win Rate: ${(nonUS.winRate * 100).toFixed(1).padStart(5)}% | ${nonUS.meetsTarget ? '✅' : '❌'}`);
      lines.push(`  Gap: ${(gap * 100).toFixed(1)}% ${gap <= CONFIG.thresholds.maxWinRateGap ? '✅' : '⚠️'  }`);
    } else if (us.count > 0) {
      lines.push(`  US Hours only: ${us.count} trades | Win Rate: ${(us.winRate * 100).toFixed(1)}%`);
    } else if (nonUS.count > 0) {
      lines.push(`  Non-US Hours only: ${nonUS.count} trades | Win Rate: ${(nonUS.winRate * 100).toFixed(1)}%`);
    } else {
      lines.push(`  No trades in this window yet`);
    }
    
    lines.push('');
  }
  
  // Recommendations
  lines.push('━'.repeat(80));
  lines.push('🎯 RECOMMENDATIONS');
  lines.push('━'.repeat(80));
  lines.push('');
  lines.push(`Current Phase: ${recommendations.phase.toUpperCase().replace(/_/g, ' ')}`);
  lines.push(`Ready for Next Phase: ${recommendations.readyForNext ? '✅ YES' : '❌ NO'}`);
  lines.push('');
  
  if (recommendations.reasoning.length > 0) {
    lines.push('Reasoning:');
    recommendations.reasoning.forEach(r => lines.push(`  ${r}`));
    lines.push('');
  }
  
  if (recommendations.warnings.length > 0) {
    lines.push('⚠️  Warnings:');
    recommendations.warnings.forEach(w => lines.push(`  ${w}`));
    lines.push('');
  }
  
  if (recommendations.nextSteps.length > 0) {
    lines.push('Next Steps:');
    recommendations.nextSteps.forEach((s, i) => lines.push(`  ${i + 1}. ${s}`));
    lines.push('');
  }
  
  // Code changes if ready
  if (recommendations.readyForNext) {
    lines.push('━'.repeat(80));
    lines.push('💻 CODE CHANGES TO ENABLE NEXT PHASE');
    lines.push('━'.repeat(80));
    lines.push('');
    
    if (recommendations.phase === 'phase_2_ready') {
      lines.push('Add this code around line 1450 in your bot:');
      lines.push('');
      lines.push('```javascript');
      lines.push('} else if (isUS) {');
      lines.push('  // US hours: CONSERVATIVE early trading (Phase 2)');
      lines.push('  if (minsLeft > 5) {');
      lines.push('    logger.log(`Skip (${minsLeft.toFixed(1)} mins left): US hours, too early`);');
      lines.push('    return;');
      lines.push('  } else if (minsLeft > 4) {');
      lines.push('    // NEW: Allow 4-5 mins with STRICT threshold');
      lines.push('    effectiveZMin = 1.8 * regimeScalar; // Very strict');
      lines.push('    logger.log(`[US EARLY] 4-5 min threshold: ${effectiveZMin.toFixed(2)}`);');
      lines.push('  } else if (minsLeft > 3) {');
      lines.push('    effectiveZMin = 1.6 * regimeScalar;');
      lines.push('  // ... rest of existing code');
      lines.push('```');
      lines.push('');
      lines.push('Run for 2 weeks, then re-analyze.');
    } else if (recommendations.phase === 'phase_3_ready') {
      lines.push('Expand US hours to 5-6 mins:');
      lines.push('');
      lines.push('```javascript');
      lines.push('} else if (isUS) {');
      lines.push('  // US hours: MODERATE early trading (Phase 3)');
      lines.push('  if (minsLeft > 6) {');
      lines.push('    logger.log(`Skip (${minsLeft.toFixed(1)} mins left): US hours, too early`);');
      lines.push('    return;');
      lines.push('  } else if (minsLeft > 5) {');
      lines.push('    effectiveZMin = 2.0 * regimeScalar; // Very strict');
      lines.push('  } else if (minsLeft > 4) {');
      lines.push('    effectiveZMin = 1.8 * regimeScalar; // Strict');
      lines.push('  // ... rest');
      lines.push('```');
    }
  }
  
  lines.push('');
  lines.push(hr);
  lines.push('END OF REPORT');
  lines.push(hr);
  
  return lines.join('\n');
}

// ============================================
// MAIN
// ============================================

async function main() {
  console.log('Moneytron Trading Metrics Analyzer v2.4.1\n');
  
  // Parse command line args
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--days' && args[i + 1]) {
      CONFIG.daysToAnalyze = parseInt(args[i + 1]);
    }
    if (args[i] === '--output' && args[i + 1]) {
      CONFIG.outputFile = args[i + 1];
    }
  }
  
  console.log(`Analyzing last ${CONFIG.daysToAnalyze} days of trading data...\n`);
  
  // Initialize analyzer
  const analyzer = new TradeAnalyzer();
  
  // Load data
  analyzer.loadOrderFiles(CONFIG.daysToAnalyze);
  
  if (analyzer.orders.length === 0) {
    console.error('❌ No order data found. Make sure you have orders-*.jsonl files.');
    process.exit(1);
  }
  
  // Match with outcomes
  await analyzer.matchOrderOutcomes();
  
  // Calculate metrics
  console.log('\nCalculating metrics...');
  const metrics = analyzer.calculateTimeWindowMetrics();
  const exitMetrics = analyzer.analyzeExitEffectiveness();
  
  // Generate recommendations
  console.log('Generating recommendations...\n');
  const recommendations = analyzer.generateRecommendations(metrics, exitMetrics);
  
  // Create report
  const report = generateReport(metrics, exitMetrics, recommendations);
  
  // Output
  console.log(report);
  
  fs.writeFileSync(CONFIG.outputFile, report);
  console.log(`\n✅ Report saved to ${CONFIG.outputFile}`);
  
  // Summary
  console.log('\n' + '='.repeat(80));
  console.log('QUICK SUMMARY');
  console.log('='.repeat(80));
  console.log(`Phase: ${recommendations.phase.toUpperCase().replace(/_/g, ' ')}`);
  console.log(`Ready for Next: ${recommendations.readyForNext ? '✅ YES' : '❌ NO'}`);
  console.log(`Total Trades: ${analyzer.trades.size}`);
  console.log(`Total Exits: ${analyzer.exits.length}`);
  console.log('='.repeat(80));
}

// Run
main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
