#!/usr/bin/env bash
# ==============================================================================
# Sokrat VoIP — Cross-Dongle Live Scenario Test Suite
# Tests inbound, outbound, early cancellation, SMS, and USSD between dongles
# ==============================================================================

set -uo pipefail

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

PASSED_COUNT=0
FAILED_COUNT=0

log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_pass() {
    echo -e "${GREEN}[PASS]${NC} $1"
    ((PASSED_COUNT++))
}

log_fail() {
    echo -e "${RED}[FAIL]${NC} $1"
    ((FAILED_COUNT++))
}

log_step() {
    echo -e "\n${YELLOW}=== $1 ===${NC}"
}

# Ensure Asterisk is running
if ! asterisk -rx "core ping" &>/dev/null; then
    log_fail "Asterisk is not running"
    exit 1
fi

# Ensure Asterisk verbose level is at least 3 for log verification
asterisk -rx "core set verbose 3" &>/dev/null

log_step "1. Detecting Active GSM Dongles"
DEVICES_OUTPUT=$(asterisk -rx "dongle show devices")
echo "$DEVICES_OUTPUT"

D0_STATUS=$(echo "$DEVICES_OUTPUT" | grep '^dongle0' || true)
D1_STATUS=$(echo "$DEVICES_OUTPUT" | grep '^dongle1' || true)

if [ -z "$D0_STATUS" ] || [ -z "$D1_STATUS" ]; then
    log_fail "Both dongle0 and dongle1 must be configured in dongle.conf"
    exit 1
fi

D0_STATE=$(echo "$D0_STATUS" | awk '{print $3}')
D1_STATE=$(echo "$D1_STATUS" | awk '{print $3}')
D0_NUM=$(echo "$D0_STATUS" | awk '{print $NF}')
D1_NUM=$(echo "$D1_STATUS" | awk '{print $NF}')

log_info "dongle0: State=$D0_STATE, Number=$D0_NUM"
log_info "dongle1: State=$D1_STATE, Number=$D1_NUM"

# Strip leading '+' and international code if present for dialing
D0_DIAL_NUM=$(echo "$D0_NUM" | sed 's/^+2//' | sed 's/^+//')
D1_DIAL_NUM=$(echo "$D1_NUM" | sed 's/^+2//' | sed 's/^+//')

if [ "$D0_STATE" != "Free" ] || [ "$D1_STATE" != "Free" ]; then
    log_info "Waiting up to 10s for both dongles to reach Free state..."
    for i in {1..10}; do
        sleep 1
        D0_STATE=$(asterisk -rx "dongle show devices" | grep '^dongle0' | awk '{print $3}')
        D1_STATE=$(asterisk -rx "dongle show devices" | grep '^dongle1' | awk '{print $3}')
        if [ "$D0_STATE" = "Free" ] && [ "$D1_STATE" = "Free" ]; then
            break
        fi
    done
fi

if [ "$D0_STATE" = "Free" ] && [ "$D1_STATE" = "Free" ]; then
    log_pass "Both dongles are online and in Free state"
else
    log_fail "Dongles not in Free state (dongle0: $D0_STATE, dongle1: $D1_STATE)"
    exit 1
fi

wait_for_free() {
    local max_wait=${1:-15}
    for ((i=1; i<=max_wait; i++)); do
        local s0=$(asterisk -rx "dongle show devices" | grep '^dongle0' | awk '{print $3}')
        local s1=$(asterisk -rx "dongle show devices" | grep '^dongle1' | awk '{print $3}')
        if [ "$s0" = "Free" ] && [ "$s1" = "Free" ]; then
            return 0
        fi
        sleep 1
    done
    return 1
}

log_step "2. Scenario: dongle0 calls dongle1 (Full Voice Call)"
log_info "Originating call from dongle0 to $D1_DIAL_NUM..."
asterisk -rx "channel originate Dongle/dongle0/$D1_DIAL_NUM application Wait 6" &>/dev/null &

RING_DETECTED=0
for i in {1..15}; do
    sleep 1
    D1_CURR=$(asterisk -rx "dongle show devices" | grep '^dongle1' | awk '{print $3}')
    if [ "$D1_CURR" = "Ring" ] || [ "$D1_CURR" = "Incoming" ]; then
        RING_DETECTED=1
        log_info "dongle1 successfully transitioned to: $D1_CURR"
        break
    fi
done

if [ "$RING_DETECTED" -eq 1 ]; then
    log_pass "dongle0 -> dongle1: Incoming ring detected on callee"
else
    log_fail "dongle0 -> dongle1: Call failed to ring dongle1 within 15s"
fi

# Wait for call to terminate naturally and verify return to Free
if wait_for_free 35; then
    log_pass "dongle0 -> dongle1: Both modems cleanly returned to Free state"
else
    log_fail "dongle0 -> dongle1: Modems did not return to Free state within 35s"
fi

log_info "Allowing 5s radio bearer settling time..."
sleep 5

log_step "3. Scenario: dongle1 calls dongle0 (Reverse Voice Call)"
log_info "Originating call from dongle1 to $D0_DIAL_NUM..."
asterisk -rx "channel originate Dongle/dongle1/$D0_DIAL_NUM application Wait 6" &>/dev/null &

RING_DETECTED=0
for i in {1..15}; do
    sleep 1
    D0_CURR=$(asterisk -rx "dongle show devices" | grep '^dongle0' | awk '{print $3}')
    if [ "$D0_CURR" = "Ring" ] || [ "$D0_CURR" = "Incoming" ]; then
        RING_DETECTED=1
        log_info "dongle0 successfully transitioned to: $D0_CURR"
        break
    fi
done

if [ "$RING_DETECTED" -eq 1 ]; then
    log_pass "dongle1 -> dongle0: Incoming ring detected on callee"
else
    log_fail "dongle1 -> dongle0: Call failed to ring dongle0 within 15s"
fi

if wait_for_free 35; then
    log_pass "dongle1 -> dongle0: Both modems cleanly returned to Free state"
else
    log_fail "dongle1 -> dongle0: Modems did not return to Free state within 35s"
fi

log_info "Allowing 5s radio bearer settling time..."
sleep 5

log_step "4. Scenario: Early Hangup while Ringing (dongle0 -> dongle1)"
log_info "Originating call from dongle0 to $D1_DIAL_NUM..."
asterisk -rx "channel originate Dongle/dongle0/$D1_DIAL_NUM application Wait 30" &>/dev/null &

ABORTED=0
for i in {1..10}; do
    sleep 1
    D1_CURR=$(asterisk -rx "dongle show devices" | grep '^dongle1' | awk '{print $3}')
    if [ "$D1_CURR" = "Ring" ] || [ "$D1_CURR" = "Incoming" ]; then
        OUT_CHAN=$(asterisk -rx "core show channels concise" | grep 'Dongle/dongle0' | cut -d'!' -f1 || true)
        if [ -n "$OUT_CHAN" ]; then
            log_info "Hanging up dialing channel $OUT_CHAN while callee is ringing..."
            asterisk -rx "channel request hangup $OUT_CHAN" &>/dev/null
            ABORTED=1
            break
        fi
    fi
done

if [ "$ABORTED" -eq 1 ]; then
    if wait_for_free 10; then
        log_pass "Early hangup handled: both modems recovered to Free state immediately"
    else
        log_fail "Early hangup failed: modems did not recover to Free state"
    fi
else
    log_fail "Could not trigger early hangup (call never reached ringing state)"
fi

sleep 2

log_step "5. Scenario: SMS Transmission between Dongles"
SMS_TEXT="Sokrat automated test $(date +%s)"
log_info "Sending SMS from dongle0 to $D1_DIAL_NUM: '$SMS_TEXT'..."
SEND_RES=$(asterisk -rx "dongle sms dongle0 $D1_DIAL_NUM \"$SMS_TEXT\"")

if echo "$SEND_RES" | grep -iq "queued for send"; then
    log_pass "SMS successfully queued for transmission by driver"
else
    log_fail "Failed to queue SMS: $SEND_RES"
fi

# Wait up to 15 seconds for SMS to arrive on dongle1
SMS_RECEIVED=0
for i in {1..15}; do
    sleep 1
    if grep -q "\[SMS-RECEIVE\] Dongle: dongle1.*$SMS_TEXT" /var/log/asterisk/full 2>/dev/null; then
        SMS_RECEIVED=1
        break
    fi
done

if [ "$SMS_RECEIVED" -eq 1 ]; then
    log_pass "SMS received and parsed by dongle1 over cellular carrier"
else
    log_fail "SMS did not appear in /var/log/asterisk/full within 15s"
fi

sleep 2

log_step "6. Scenario: USSD Query & Response"
log_info "Sending USSD *100# on dongle0..."
USSD_SENT=$(asterisk -rx "dongle ussd dongle0 *100#")

if echo "$USSD_SENT" | grep -iq "queued for send"; then
    log_pass "USSD successfully queued for transmission by driver"
else
    log_fail "Failed to queue USSD: $USSD_SENT"
fi

# Check for USSD response in log
USSD_RECEIVED=0
START_TIME=$(date +%s)
for i in {1..12}; do
    sleep 1
    if grep -q -i "Got USSD type" /var/log/asterisk/full 2>/dev/null; then
        USSD_LINE=$(grep -i "Got USSD type" /var/log/asterisk/full | tail -n 1)
        USSD_RECEIVED=1
        log_info "USSD Response: $USSD_LINE"
        break
    fi
done

if [ "$USSD_RECEIVED" -eq 1 ]; then
    log_pass "USSD response received from cellular network"
else
    log_fail "No USSD response received within 12s"
fi

if wait_for_free 10; then
    log_pass "dongle0 returned to Free state after USSD"
else
    log_fail "dongle0 did not return to Free state after USSD"
fi

echo -e "\n${YELLOW}==============================================${NC}"
echo -e "${YELLOW}  TEST RESULTS SUMMARY${NC}"
echo -e "${YELLOW}==============================================${NC}"
echo -e "Passed: ${GREEN}$PASSED_COUNT${NC}"
echo -e "Failed: ${RED}$FAILED_COUNT${NC}"

if [ "$FAILED_COUNT" -eq 0 ]; then
    echo -e "${GREEN}ALL SCENARIOS PASSED SUCCESSFULLY!${NC}\n"
    exit 0
else
    echo -e "${RED}SOME SCENARIOS FAILED.${NC}\n"
    exit 1
fi
