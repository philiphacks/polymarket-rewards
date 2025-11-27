#!/bin/bash
# Convenience script to run trading metrics analysis

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${BLUE}════════════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}   MONEYTRON METRICS ANALYZER${NC}"
echo -e "${BLUE}════════════════════════════════════════════════════════════${NC}"
echo ""

# Check if files directory exists
if [ ! -d "./files" ]; then
    echo -e "${YELLOW}⚠️  Warning: ./files/ directory not found${NC}"
    echo "Your log files should be in ./files/"
    echo ""
    echo "Expected structure:"
    echo "  ./files/orders-*.jsonl"
    echo "  ./files/ticks-*.jsonl"
    echo ""
    exit 1
fi

# Check if any log files exist
ORDER_COUNT=$(ls -1 ./files/orders-*.jsonl 2>/dev/null | wc -l)
if [ "$ORDER_COUNT" -eq 0 ]; then
    echo -e "${YELLOW}⚠️  Warning: No order log files found in ./files/${NC}"
    echo "Make sure you have orders-*.jsonl files in ./files/"
    echo ""
    exit 1
fi

echo -e "${GREEN}Found $ORDER_COUNT order log files in ./files/${NC}"
echo ""

# Parse arguments
DAYS=14
OUTPUT=""
QUICK=false

while [[ $# -gt 0 ]]; do
    case $1 in
        --quick)
            QUICK=true
            shift
            ;;
        --days)
            DAYS="$2"
            shift 2
            ;;
        --output)
            OUTPUT="$2"
            shift 2
            ;;
        --help)
            echo "Usage: ./check_metrics.sh [OPTIONS]"
            echo ""
            echo "Options:"
            echo "  --quick          Run daily stats only (fast)"
            echo "  --days N         Analyze last N days (default: 14)"
            echo "  --output FILE    Save report to FILE"
            echo "  --help           Show this help"
            echo ""
            echo "Examples:"
            echo "  ./check_metrics.sh"
            echo "  ./check_metrics.sh --quick"
            echo "  ./check_metrics.sh --days 30"
            echo "  ./check_metrics.sh --output weekly_report.txt"
            exit 0
            ;;
        *)
            echo "Unknown option: $1"
            echo "Use --help for usage information"
            exit 1
            ;;
    esac
done

# Quick mode - just daily stats
if [ "$QUICK" = true ]; then
    echo -e "${GREEN}Running quick daily stats...${NC}"
    echo ""
    node daily_stats.js
    exit 0
fi

# Full analysis
echo -e "${GREEN}Step 1: Daily Stats (Quick Overview)${NC}"
echo "─────────────────────────────────────────────────────────────"
node daily_stats.js
echo ""
echo ""

echo -e "${GREEN}Step 2: Comprehensive Analysis (Last $DAYS days)${NC}"
echo "─────────────────────────────────────────────────────────────"

if [ -n "$OUTPUT" ]; then
    node analyze_trading_metrics.js --days "$DAYS" --output "$OUTPUT"
    echo ""
    echo -e "${GREEN}✅ Report saved to: $OUTPUT${NC}"
else
    node analyze_trading_metrics.js --days "$DAYS"
    echo ""
    echo -e "${GREEN}✅ Report saved to: trading_metrics_report.txt${NC}"
fi

echo ""
echo -e "${BLUE}════════════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}   ANALYSIS COMPLETE${NC}"
echo -e "${BLUE}════════════════════════════════════════════════════════════${NC}"
echo ""

# Check if report recommends action
REPORT_FILE=${OUTPUT:-trading_metrics_report.txt}
if [ -f "$REPORT_FILE" ]; then
    if grep -q "Ready for Next Phase: ✅ YES" "$REPORT_FILE"; then
        echo -e "${YELLOW}🎯 ACTION REQUIRED: You're ready for the next phase!${NC}"
        echo "Check the CODE CHANGES section in the report."
        echo ""
    elif grep -q "Ready for Next Phase: ❌ NO" "$REPORT_FILE"; then
        echo -e "${GREEN}✓ Status: Continue current settings${NC}"
        echo "Keep monitoring, not ready to advance yet."
        echo ""
    fi
fi

echo "Next steps:"
echo "  • Review the full report for details"
echo "  • Run daily: ./check_metrics.sh --quick"
echo "  • Run weekly: ./check_metrics.sh"
echo ""
