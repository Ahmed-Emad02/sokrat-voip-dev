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

# Sokrat Service Status
SOKRAT_STATUS=$(systemctl is-active sokrat-voip 2>/dev/null || echo "unknown")
if [ "$SOKRAT_STATUS" = "active" ]; then
    echo -e "${WHITE}Sokrat Service: ${GREEN}● ACTIVE${RESET}"
else
    echo -e "${WHITE}Sokrat Service: ${RED}○ INACTIVE${RESET}"
fi

# Asterisk Status
asterisk_version=$(asterisk -rx "core show version" 2>/dev/null | awk 'NR==1{print $1" "$2}')
if [ -z "$asterisk_version" ] || [[ "$asterisk_version" == "Unable to"* ]]; then
    echo -e "${WHITE}Asterisk:       ${RED}○ OFFLINE${RESET}"
else
    asterisk_calls=$(asterisk -rx "core show channels" 2>/dev/null | grep "active calls" | awk '{print $1}')
    [ -z "$asterisk_calls" ] && asterisk_calls="0"
    echo -e "${WHITE}Asterisk:       ${GREEN}● ${asterisk_version} ${WHITE}Active Calls: ${RED}${asterisk_calls}${RESET}"
fi

# System load and stats
user=$(whoami)
load=$(cat /proc/loadavg 2>/dev/null | awk '{print $1" (1m) "$2" (5m) "$3" (15m)"}' || echo "unknown")
uptime_val=$(uptime -p 2>/dev/null || uptime 2>/dev/null | sed 's/.*up \([^,]*\).*/\1/' || echo "unknown")
memory_usage=$(free -m 2>/dev/null | awk '/Mem:/ { printf("%3.0f%%", ($3/$2)*100)}' || echo "0%")
memory=$(free -m 2>/dev/null | awk '/Mem:/ { print $2 }' || echo "0")
mem_used=$(free -m 2>/dev/null | awk '/Mem:/ { print $3 }' || echo "0")
swap_usage=$(free -m 2>/dev/null | awk '/Swap/ { if($2>0) printf("%3.1f%%", $3/$2*100); else print "0.0%" }' || echo "0.0%")

users_count=$(who -q 2>/dev/null | grep users= | awk -F= '{print $2}' || echo "0")
processes_total=$(ps aux 2>/dev/null | wc -l || echo "0")
processes_user=$(ps -U "${user}" u 2>/dev/null | wc -l || echo "0")

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

root_disk_gauge="${WHITE}[${RED}$(print_bar "$root_used")${WHITE}] ${RED}${root_used_print}"

if [ "$memory" -gt 0 ]; then
    mem_used_percent=$((mem_used * 100 / memory))
else
    mem_used_percent=0
fi
mem_gauge="${WHITE}[${RED}$(print_bar "$mem_used_percent")${WHITE}] ${RED}${memory_usage}"

echo -e "${WHITE}System load:    ${RED}${load} ${WHITE}Uptime: ${RED}${uptime_val}${RESET}"
echo -e "${WHITE}Memory:         ${mem_gauge} ${RED}${mem_used}/${memory}MB${RESET}"
echo -e "${WHITE}Usage on /:     ${root_disk_gauge} ${RED}${root_usedgb}/${root_total}${RESET}"
echo -e "${WHITE}Swap usage:     ${RED}${swap_usage}${RESET}"
echo -e "${WHITE}SSH logins:     ${RED}${users_count} open sessions${RESET}"
echo -e "${WHITE}Processes:      ${RED}${processes_total} total, ${processes_user} yours${RESET}"
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
            printf "${BOLD}%-11s%-15s%-11s%-18s%-16s${RESET}\n" "DEVICE" "STATE" "RSSI" "PROVIDER" "PHONE NUMBER"
            
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
                
                id_str = sprintf("%-11s", id)
                state_color = GREEN
                state_symbol = "●"
                if (state != "Free") {
                    state_color = RED
                    state_symbol = "○"
                }
                state_text = sprintf("%-12s", state)
                state_col = state_color state_symbol " " state_text RESET

                rssi_val = rssi + 0
                rssi_bar = " "
                if (rssi_val >= 15) { rssi_bar = "█" }
                else if (rssi_val >= 10) { rssi_bar = "▆" }
                else if (rssi_val >= 5) { rssi_bar = "▃" }

                rssi_text = sprintf("%-9s", rssi)
                rssi_col = GREEN rssi_bar RESET " " rssi_text

                prov_str = sprintf("%-18s", prov)
                num_str = sprintf("%-16s", num)

                printf "%s%s%s%s%s\n", id_str, state_col, rssi_col, prov_str, num_str
            }
            '
        fi
    fi
fi
echo ""
