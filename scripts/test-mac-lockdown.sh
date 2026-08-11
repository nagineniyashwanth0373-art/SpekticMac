#!/bin/bash
# ==========================================================
# Spektic macOS Network Lockdown Diagnostic & Verifier Tool
# Run this on macOS to inspect firewall and network status
# ==========================================================

echo "=========================================================="
echo "    SPEKTIC macOS NETWORK LOCKDOWN DIAGNOSTIC TOOL"
echo "=========================================================="
echo "Date: $(date)"
echo "Host: $(uname -a)"
echo ""

LOG_FILE="/tmp/spektic_network_lockdown.log"
FW_EXEC_LOG="/tmp/spektic_fw_exec.log"

# 1. Check Log Files
echo "--- 1. LOG FILES STATUS ---"
if [ -f "$LOG_FILE" ]; then
    echo "✅ Found $LOG_FILE (Size: $(stat -f%z "$LOG_FILE" 2>/dev/null || stat -c%s "$LOG_FILE" 2>/dev/null) bytes)"
    echo "Last 15 lines of lockdown log:"
    tail -n 15 "$LOG_FILE"
else
    echo "⚠️ Log file $LOG_FILE not found (App may not have run yet)."
fi
echo ""

if [ -f "$FW_EXEC_LOG" ]; then
    echo "✅ Found $FW_EXEC_LOG"
    echo "Execution output:"
    tail -n 15 "$FW_EXEC_LOG"
fi
echo ""

# 2. Check Route Table
echo "--- 2. ROUTING TABLE (LAYER 1) ---"
DEFAULT_ROUTE=$(/sbin/route -n get default 2>&1)
echo "Default route query output:"
echo "$DEFAULT_ROUTE"
if echo "$DEFAULT_ROUTE" | grep -q "not in table"; then
    echo "✅ PASS: Default route is DELETED (Internet blocked at Layer 1)"
else
    echo "❌ FAIL: Default route is ACTIVE (Internet NOT blocked at Layer 1)"
fi
echo ""

# 3. Check PFCTL Packet Filter
echo "--- 3. KERNEL PACKET FILTER (LAYER 2) ---"
PF_INFO=$(sudo /sbin/pfctl -s info 2>&1)
echo "$PF_INFO" | head -n 5
if echo "$PF_INFO" | grep -iq "Status: Enabled"; then
    echo "✅ PASS: pfctl is ENABLED"
else
    echo "❌ FAIL: pfctl is NOT enabled"
fi
echo ""

echo "Loaded PF Rules:"
sudo /sbin/pfctl -s rules 2>&1 | head -n 20
echo ""

# 4. Live Connectivity Tests
echo "--- 4. LIVE CONNECTIVITY TESTS ---"
echo -n "Testing Google.com (should FAIL)... "
GOOGLE_TEST=$(curl -I -s --connect-timeout 2 --max-time 3 https://www.google.com 2>&1)
if [ $? -ne 0 ] || echo "$GOOGLE_TEST" | grep -iq "Could not resolve\|timed out\|Failed to connect\|unreachable"; then
    echo "✅ PASS (Blocked: $GOOGLE_TEST)"
else
    echo "❌ FAIL (Connected to Google! Output: $(echo "$GOOGLE_TEST" | head -n 1))"
fi

echo -n "Testing Spektic.com (should PASS)... "
SPEKTIC_TEST=$(curl -I -s --connect-timeout 4 --max-time 6 https://spektic.com/join 2>&1)
if echo "$SPEKTIC_TEST" | grep -iq "HTTP/\|200\|301\|302\|308"; then
    echo "✅ PASS (Connected: $(echo "$SPEKTIC_TEST" | head -n 1))"
else
    echo "⚠️ WARN (Result: $SPEKTIC_TEST)"
fi

echo ""
echo "=========================================================="
echo "Diagnostic complete."
echo "=========================================================="
