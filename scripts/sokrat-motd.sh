#!/bin/bash
# scripts/sokrat-motd.sh

# Do not crash
set +e

# Mute error outputs unless explicitly debugging
# exec 2>/dev/null

RED='\033[1;31m'
GREEN='\033[1;32m'
YELLOW='\033[1;33m'
BLUE='\033[1;34m'
MAGENTA='\033[1;35m'
CYAN='\033[1;36m'
WHITE='\033[1;37m'
RESET='\033[0m'
BOLD='\033[1m'
DIM='\033[2m'
# Terminal clean header: clear previous lastlogin/failed login messages if interactive
if [ -t 1 ]; then
    clear 2>/dev/null || true
fi
echo ""
# ASCII Logo
echo -e "${RED}${BOLD}  ███████╗ ██████╗ ██╗  ██╗██████╗  █████╗ ████████╗"
echo -e "  ██╔════╝██╔═══██╗██║ ██╔╝██╔══██╗██╔══██╗╚══██╔══╝"
echo -e "  ███████╗██║   ██║█████╔╝ ██████╔╝███████║   ██║   "
echo -e "  ╚════██║██║   ██║██╔═██╗ ██╔══██╗██╔══██║   ██║   "
echo -e "  ███████║╚██████╔╝██║  ██╗██║  ██║██║  ██║   ██║   "
echo -e "  ╚══════╝ ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝   ╚═╝   ${RESET}"
echo -e "  ${WHITE}${BOLD}SOKRAT VOIP Enterprise PBX Dashboard v1.0.4${RESET}"
echo ""

# Web URL
echo -e "${BOLD}Dashboard Access:${RESET}"
INTFCNET=$(ls -A /sys/class/net/ 2>/dev/null || echo "")
IP_FOUND=0
for x in $INTFCNET; do
    case $x in
        lo*|sit*) ;;
        eth*|en*|ww*|wl*|sl*)
            IPADDR=$(ip a s $x 2>/dev/null | awk -F"[/ ]+" '/inet / {print $3}')
            for IP in $IPADDR; do
                echo -e "  ${CYAN}https://${IP}${RESET}"
                IP_FOUND=1
            done
        ;;
    esac
done
if [ "$IP_FOUND" -eq 0 ]; then
    echo -e "  ${CYAN}https://<YOUR-IP>${RESET}"
fi
echo ""

# System & PBX Status Section
echo -e "${WHITE}${BOLD}System & PBX Status${RESET}"

# Sokrat Service Status
SOKRAT_STATUS=$(systemctl is-active sokrat-voip 2>/dev/null || echo "unknown")
if [ "$SOKRAT_STATUS" = "active" ]; then
    SOKRAT_STATUS_STR="${GREEN}● ACTIVE${RESET}"
else
    SOKRAT_STATUS_STR="${RED}○ INACTIVE${RESET}"
fi

# Asterisk Status & Active Calls
asterisk_version=$(asterisk -rx "core show version" 2>/dev/null | awk 'NR==1{print $1" "$2}')
if [ -z "$asterisk_version" ] || [[ "$asterisk_version" == "Unable to"* ]]; then
    AST_STATUS_STR="${RED}○ OFFLINE${RESET}"
    AST_CALLS_STR="${RED}0${RESET}"
    EXT_STATUS_STR="${RED}Offline${RESET}"
else
    AST_STATUS_STR="${GREEN}● ${asterisk_version}${RESET}"
    asterisk_calls=$(asterisk -rx "core show channels" 2>/dev/null | grep "active calls" | awk '{print $1}')
    [ -z "$asterisk_calls" ] && asterisk_calls="0"
    AST_CALLS_STR="${RED}${asterisk_calls}${RESET}"

    # Query extensions (SIP + PJSIP)
    peers_line=$(asterisk -rx "sip show peers" 2>/dev/null | grep -i "sip peers" | tr -d '\r\n' || echo "")
    if [ -n "$peers_line" ]; then
        online_peers=$(echo "$peers_line" | sed -e 's/.*Monitored: \([0-9]*\) online.*/\1/' || echo "0")
        total_peers=$(echo "$peers_line" | awk '{print $1}' || echo "0")
        EXT_STATUS_STR="${GREEN}${online_peers} online${RESET} / ${total_peers} total"
    else
        EXT_STATUS_STR="${RED}0 online${RESET}"
    fi
fi

# Calls Today from MySQL CDR (fast read from issabel config if available)
MYSQL_PWD=$(grep -s mysqlrootpwd /etc/issabel.conf 2>/dev/null | cut -d= -f2- | xargs || echo "")
if [ -n "$MYSQL_PWD" ]; then
    CALLS_TODAY=$(mysql -u root -p"${MYSQL_PWD}" -N -e "SELECT COUNT(*) FROM asteriskcdrdb.cdr WHERE calldate >= CURDATE();" 2>/dev/null || echo "")
fi
[ -z "$CALLS_TODAY" ] && CALLS_TODAY="0"
CALLS_TODAY_STR="${RED}${CALLS_TODAY} calls${RESET}"

# System load and stats
user=$(whoami)
load_1m=$(cat /proc/loadavg 2>/dev/null | awk '{print $1" (1m)  "$2" (5m)"}' || echo "unknown")
uptime_val=$(uptime -p 2>/dev/null | sed -e 's/^up //' -e 's/ weeks\?,/w/' -e 's/ days\?,/d/' -e 's/ hours\?,/h/' -e 's/ minutes\?/m/' || uptime 2>/dev/null | sed 's/.*up \([^,]*\).*/\1/' || echo "unknown")
memory_usage=$(free -m 2>/dev/null | awk '/Mem:/ { printf("%3.0f%%", ($3/$2)*100)}' || echo "0%")
memory=$(free -m 2>/dev/null | awk '/Mem:/ { print $2 }' || echo "0")
mem_used=$(free -m 2>/dev/null | awk '/Mem:/ { print $3 }' || echo "0")

users_count=$(who -q 2>/dev/null | grep users= | awk -F= '{print $2}' || echo "0")

root_total=$(df -h / 2>/dev/null | awk '/\// {print $(NF-4)}' || echo "0G")
root_usedgb=$(df -h / 2>/dev/null | awk '/\// {print $(NF-3)}' || echo "0G")
root_used=$(df -h / 2>/dev/null | awk '/\// {print $(NF-1)}' | sed 's/[^0-9]//g' || echo "0")
[ -z "$root_used" ] && root_used=0
root_used_print=$(printf "%3.0f%%" $root_used)

print_bar() {
    local percent=$1
    local length=10
    local used=$((percent * length / 100))
    local free=$((length - used))
    local bar=""
    
    if [ "$used" -gt 0 ]; then
        for ((i=1; i<used; i++)); do bar="${bar}="; done
        bar="${bar}>"
    fi
    for ((i=0; i<free; i++)); do bar="${bar}-"; done
    echo -n "$bar"
}

root_disk_gauge="${WHITE}[${RED}$(print_bar "$root_used")${WHITE}] ${RED}${root_used_print}${RESET}"

if [ "$memory" -gt 0 ]; then
    mem_used_percent=$((mem_used * 100 / memory))
else
    mem_used_percent=0
fi
mem_gauge="${WHITE}[${RED}$(print_bar "$mem_used_percent")${WHITE}] ${RED}${memory_usage}${RESET}"
# Infrastructure & Services Health Strip
SVC_DB=$(systemctl is-active mariadb >/dev/null 2>&1 && echo -e "${GREEN}●${RESET}" || echo -e "${RED}○${RESET}")
SVC_HTTP=$(systemctl is-active httpd >/dev/null 2>&1 && echo -e "${GREEN}●${RESET}" || echo -e "${RED}○${RESET}")
SVC_PUSH=$(systemctl is-active sokrat-push-gateway >/dev/null 2>&1 && echo -e "${GREEN}●${RESET}" || echo -e "${RED}○${RESET}")
SVC_STT=$(systemctl is-active sokrat-stt >/dev/null 2>&1 && echo -e "${GREEN}●${RESET}" || echo -e "${RED}○${RESET}")
SVC_WD=$(systemctl is-active sokrat-watchdog >/dev/null 2>&1 && echo -e "${GREEN}●${RESET}" || echo -e "${RED}○${RESET}")
# Infrastructure & Services Health Strip
SVC_DB=$(systemctl is-active mariadb >/dev/null 2>&1 && echo -e "${GREEN}●${RESET}" || echo -e "${RED}○${RESET}")
SVC_HTTP=$(systemctl is-active httpd >/dev/null 2>&1 && echo -e "${GREEN}●${RESET}" || echo -e "${RED}○${RESET}")
SVC_PUSH=$(systemctl is-active sokrat-push-gateway >/dev/null 2>&1 && echo -e "${GREEN}●${RESET}" || echo -e "${RED}○${RESET}")
SVC_STT=$(systemctl is-active sokrat-stt >/dev/null 2>&1 && echo -e "${GREEN}●${RESET}" || echo -e "${RED}○${RESET}")
SVC_WD=$(systemctl is-active sokrat-watchdog >/dev/null 2>&1 && echo -e "${GREEN}●${RESET}" || echo -e "${RED}○${RESET}")
STACK_HEALTH="DB: ${SVC_DB}       Web: ${SVC_HTTP}       Push: ${SVC_PUSH}       STT: ${SVC_STT}       Watchdog: ${SVC_WD}"

pad_vis() {
    local text="$1"
    local width="$2"
    local plain=$(echo -e "$text" | sed 's/\x1b\[[0-9;]*m//g')
    local plen=${#plain}
    local pad=$((width - plen))
    echo -ne "$text"
    if [ $pad -gt 0 ]; then
        printf "%*s" $pad ""
    fi
}

print_stat_row() {
    local l1="$1"
    local v1="$2"
    local l2="$3"
    local v2="$4"

    echo -n "  "
    pad_vis "${WHITE}${l1}${RESET}" 18
    pad_vis "${v1}" 30
    pad_vis "${WHITE}${l2}${RESET}" 18
    echo -e "${v2}"
}

# Output perfectly aligned 2-column grid
print_stat_row "Sokrat Service:" "${SOKRAT_STATUS_STR}" "Active Calls:" "${AST_CALLS_STR}"
print_stat_row "Asterisk Core:" "${AST_STATUS_STR}" "SIP Extensions:" "${EXT_STATUS_STR}"
print_stat_row "System Load:" "${RED}${load_1m}${RESET}" "Calls Today:" "${CALLS_TODAY_STR}"
print_stat_row "System Uptime:" "${RED}${uptime_val}${RESET}" "SSH Sessions:" "${RED}${users_count} open${RESET}"
print_stat_row "Memory (RAM):" "${mem_gauge} ${RED}${mem_used}/${memory}MB${RESET}" "Root Disk (/):" "${root_disk_gauge} ${RED}${root_usedgb}/${root_total}${RESET}"
echo ""
echo -e "  ${WHITE}Stack Services:   ${RESET}${STACK_HEALTH}"
echo ""

# GSM Dongles Section
echo -e "${WHITE}${BOLD}GSM Dongles${RESET}"
if [ -z "$asterisk_version" ] || [[ "$asterisk_version" == "Unable to"* ]]; then
    echo -e "${DIM}No GSM dongles detected / Asterisk offline${RESET}"
else
    dongles_out=$(asterisk -rx "dongle show devices" 2>/dev/null)
    if [ $? -ne 0 ] || [ -z "$dongles_out" ] || echo "$dongles_out" | grep -iq "No such command"; then
        echo -e "${DIM}No GSM dongles detected / Asterisk offline${RESET}"
    else
        lines_count=$(echo "$dongles_out" | wc -l)
        if [ "$lines_count" -le 1 ]; then
            echo -e "${DIM}No GSM dongles connected${RESET}"
        else
            printf "${BOLD}%-13s%-15s%-11s%-18s%-16s${RESET}\n" "DEVICE" "STATE" "RSSI" "PROVIDER" "PHONE NUMBER"
            
            echo "$dongles_out" | awk '
            NR==1 {
                id_idx=index($0, "ID")
                state_idx=index($0, "State")
                rssi_idx=index($0, "RSSI")
                prov_idx=index($0, "Provider Name")
                num_idx=index($0, "Number")
                # find endpoints
                col_end[1] = index($0, "Group") - 1
                col_end[2] = index($0, "RSSI") - 1
                col_end[3] = index($0, "Mode") - 1
                col_end[4] = index($0, "Model") - 1
                col_end[5] = length($0)
                next
            }
            /^-----/ { next }
            /^$/ { next }
            {
                id = substr($0, id_idx, col_end[1] - id_idx + 1)
                sub(/^[ \t]+|[ \t]+$/, "", id)
                
                state = substr($0, state_idx, col_end[2] - state_idx + 1)
                sub(/^[ \t]+|[ \t]+$/, "", state)
                
                rssi = substr($0, rssi_idx, col_end[3] - rssi_idx + 1)
                sub(/^[ \t]+|[ \t]+$/, "", rssi)
                
                prov = substr($0, prov_idx, col_end[4] - prov_idx + 1)
                sub(/^[ \t]+|[ \t]+$/, "", prov)
                
                num = substr($0, num_idx, col_end[5] - num_idx + 1)
                sub(/^[ \t]+|[ \t]+$/, "", num)
                
                if (id == "") next
                if (id == "ID") next # header repeating somehow
                
                # Colors
                RESET="\033[0m"
                GREEN="\033[1;32m"
                RED="\033[1;31m"
                YELLOW="\033[1;33m"
                DIM="\033[2m"
                
                id_str = sprintf("%-13s", id)
                state_color = GREEN
                state_symbol = "●"
                if (state != "Free") {
                    state_color = RED
                    state_symbol = "○"
                }
                state_text = sprintf("%-13s", state)
                state_col = state_color state_symbol " " state_text RESET

                rssi_val = rssi + 0
                rssi_color = GREEN
                if (rssi_val < 10) { rssi_color = RED }
                else if (rssi_val < 15) { rssi_color = YELLOW }

                rssi_text = sprintf("%-11s", rssi "/31")
                rssi_col = rssi_color rssi_text RESET

                prov_str = sprintf("%-18s", prov)
                num_str = sprintf("%-16s", num)

                printf "%s%s%s%s%s\n", id_str, state_col, rssi_col, prov_str, num_str
            }
            '
        fi
    fi
fi
echo ""

# Network Addresses Section
echo -e "${WHITE}${BOLD}Network Addresses${RESET}"
printf "${BOLD}%-13s%-15s%-24s%-18s${RESET}\n" "INTERFACE" "TYPE" "IPV4 ADDRESS" "SCOPE / INFO"

ip -4 -o addr show 2>/dev/null | awk '
{
    intf = $2
    sub(/@.*/, "", intf)
    sub(/:.*/, "", intf)

    if (intf ~ /^(lo|docker|veth|br-|cni|flannel)/) next

    ipaddr = ""
    for (i = 1; i <= NF; i++) {
        if ($i == "inet") {
            ipaddr = $(i+1)
            sub(/\/.*$/, "", ipaddr)
            break
        }
    }

    if (ipaddr == "" || ipaddr == "127.0.0.1") next

    RESET = "\033[0m"
    RED = "\033[1;31m"
    GREEN = "\033[1;32m"
    CYAN = "\033[1;36m"

    if (intf ~ /^(tailscale|wg|tun|tap|zt)/) {
        type = "VPN/Mesh"
        color = CYAN
        scope = "VPN Overlay"
    } else if (ipaddr ~ /^10\./ || ipaddr ~ /^172\.(1[6-9]|2[0-9]|3[0-1])\./ || ipaddr ~ /^192\.168\./) {
        type = "Private"
        color = GREEN
        scope = "Internal LAN"
    } else {
        type = "Public"
        color = RED
        scope = "Public Interface"
    }

    intf_str = sprintf("%-13s", intf)
    type_text = sprintf("%-13s", type)
    type_col = color "● " type_text RESET
    ip_str = sprintf("%-24s", ipaddr)
    scope_str = sprintf("%-18s", scope)

    printf "%s%s%s%s\n", intf_str, type_col, ip_str, scope_str
}
'

CACHE_FILE="${SOKRAT_PUBLIC_IP_CACHE:-/tmp/.sokrat_public_ip}"
NOW=$(date +%s 2>/dev/null || echo 0)
MTIME=0
CACHE_EXISTS=0

if [ -f "$CACHE_FILE" ]; then
    CACHE_EXISTS=1
    MTIME=$(stat -c %Y "$CACHE_FILE" 2>/dev/null || stat -f %m "$CACHE_FILE" 2>/dev/null || echo 0)
fi

AGE=$((NOW - MTIME))
if [ "$CACHE_EXISTS" -eq 0 ] || [ "$AGE" -gt 300 ]; then
    (curl -s -m 1 --connect-timeout 1 ifconfig.me > "$CACHE_FILE" 2>/dev/null &)
fi

PUBLIC_IP=""
if [ -f "$CACHE_FILE" ]; then
    PUBLIC_IP=$(tr -d ' \t\r\n' < "$CACHE_FILE" 2>/dev/null)
fi

if [[ "$PUBLIC_IP" =~ ^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$ ]]; then
    WAN_IP="$PUBLIC_IP"
elif [ "$CACHE_EXISTS" -eq 0 ]; then
    WAN_IP="Pending / Resolving..."
else
    WAN_IP="Unavailable / Offline"
fi

WAN_INTF=$(printf "%-13s" "external")
WAN_TYPE_TEXT=$(printf "%-13s" "Public")
WAN_TYPE_COL=$(echo -e "${RED}● ${WAN_TYPE_TEXT}${RESET}")
WAN_IP_STR=$(printf "%-24s" "$WAN_IP")
WAN_SCOPE_STR=$(printf "%-18s" "External Gateway")

printf "%s%s%s%s\n" "$WAN_INTF" "$WAN_TYPE_COL" "$WAN_IP_STR" "$WAN_SCOPE_STR"
echo ""
