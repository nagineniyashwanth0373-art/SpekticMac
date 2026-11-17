#!/bin/bash
# ==========================================================
# Spektic macOS Network Lockdown Diagnostic & Verifier Tool
# Run this on macOS to inspect network isolation status
# ==========================================================

echo "=========================================================="
echo "    SPEKTIC macOS NETWORK ISOLATION DIAGNOSTIC TOOL"
echo "=========================================================="
echo "Date: $(date)"
echo "Host: $(uname -a)"
echo ""

LOG_FILE="/tmp/spektic_network_lockdown.log"

# 1. Check Log Files
echo "--- 1. SPEKTIC LOG FILE STATUS ---"
if [ -f "$LOG_FILE" ]; then
    echo "✅ Found $LOG_FILE"
    echo "Last 15 lines of lockdown log:"
    tail -n 15 "$LOG_FILE"
else
    echo "⚠️ Log file $LOG_FILE not found (App may not have run yet)."
fi
echo ""

# 2. Check System Proxy Blackhole Status
echo "--- 2. SYSTEM PROXY STATUS (NETWORK ISOLATION) ---"
SERVICES=$(networksetup -listallnetworkservices 2>/dev/null | grep -v 'An asterisk' | grep -v '\*')
for s in $SERVICES; do
    echo "Service: [$s]"
    WEB_STATUS=$(networksetup -getwebproxy "$s" 2>/dev/null)
    SEC_STATUS=$(networksetup -getsecurewebproxy "$s" 2>/dev/null)
    SOCKS_STATUS=$(networksetup -getsocksfirewallproxy "$s" 2>/dev/null)
    
    if echo "$WEB_STATUS" | grep -iq "Enabled: Yes"; then
        echo "  🔒 HTTP Proxy: ENABLED (Blackhole: $(echo "$WEB_STATUS" | grep 'Server:' | awk '{print $2}'):$(echo "$WEB_STATUS" | grep 'Port:' | awk '{print $2}'))"
    else
        echo "  🔓 HTTP Proxy: DISABLED (Normal Internet)"
    fi

    if echo "$SEC_STATUS" | grep -iq "Enabled: Yes"; then
        echo "  🔒 HTTPS Proxy: ENABLED (Blackhole: $(echo "$SEC_STATUS" | grep 'Server:' | awk '{print $2}'):$(echo "$SEC_STATUS" | grep 'Port:' | awk '{print $2}'))"
    else
        echo "  🔓 HTTPS Proxy: DISABLED (Normal Internet)"
    fi
done
echo ""

# 3. Live Connectivity Tests for External Apps
echo "--- 3. LIVE CONNECTIVITY TESTS (EXTERNAL APPS) ---"
echo -n "Testing Google.com via System Stack (should FAIL while Spektic is running)... "
GOOGLE_TEST=$(curl -I -s --connect-timeout 2 --max-time 3 https://www.google.com 2>&1)
if [ $? -ne 0 ] || echo "$GOOGLE_TEST" | grep -iq "Could not resolve\|timed out\|Failed to connect\|unreachable\|Connection refused\|Proxy"; then
    echo "✅ PASS (Blocked for external apps: $GOOGLE_TEST)"
else
    echo "ℹ️ Note (Current connection: $(echo "$GOOGLE_TEST" | head -n 1))"
fi

echo ""
echo "=========================================================="
echo "Diagnostic complete."
echo "=========================================================="
