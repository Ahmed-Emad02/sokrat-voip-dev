#!/bin/bash
# ==============================================================================
# Sokrat VOIP — 1-Command Automated Bootstrap Installer
# Target OS: Rocky Linux 8.x
#
# This bootstrap script collects all user configuration questions FIRST,
# before downloading git, cloning the repository, or installing any packages.
# Once inputs are entered, the entire installation runs unattended.
#
# Usage (run as root on fresh Rocky Linux 8):
#   curl -fsSL https://raw.githubusercontent.com/Ahmed-Emad02/sokrat-voip-dev/main/bootstrap.sh | bash
# ==============================================================================
set -euo pipefail

export PATH="/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin:${PATH:-}"

INSTALL_DIR="/opt/sokrat-voip"
REPO_URL="https://github.com/Ahmed-Emad02/sokrat-voip-dev.git"
REPO_BRANCH="main"
SOKRAT_INPUTS_FILE="${SOKRAT_INPUTS_FILE:-/var/lib/sokrat/install-inputs.env}"

echo "=================================================================="
echo " Sokrat VOIP — Master Appliance Setup"
echo " Target OS: Rocky Linux 8.x (Issabel 5 & Asterisk 18)"
echo "=================================================================="

# ──────────────────────────────────────────────────────────────────────────────
# Step 1: Collect all interactive input FIRST before downloading anything
# ──────────────────────────────────────────────────────────────────────────────
collect_client_name() {
    local input_fd
    local user_val=""
    local default_name="sokrat"

    if [[ -n "${CLIENT_NAME:-}" ]]; then
        return 0
    fi

    local current_host
    current_host=$(hostname -s 2>/dev/null || hostname 2>/dev/null || echo "")
    if [[ -n "$current_host" && "$current_host" != "localhost" && "$current_host" != "issabel" && "$current_host" != "issabel.local" ]]; then
        default_name="$current_host"
    fi

    if [[ -t 0 ]]; then
        input_fd=0
    elif { exec 3<>/dev/tty; } 2>/dev/null; then
        input_fd=3
    elif [[ -t 1 ]] && { exec 3<>/proc/self/fd/1; } 2>/dev/null; then
        input_fd=3
    elif [[ -t 2 ]] && { exec 3<>/proc/self/fd/2; } 2>/dev/null; then
        input_fd=3
    else
        CLIENT_NAME="$default_name"
        return 0
    fi

    while true; do
        printf "Enter the client name for this server [default: %s]: " "$default_name"
        if ! IFS= read -r -u "$input_fd" user_val; then
            if [[ "$input_fd" -eq 3 ]]; then
                exec 3>&-
            fi
            CLIENT_NAME="$default_name"
            break
        fi

        user_val="$(echo "$user_val" | xargs)"
        if [[ -z "$user_val" ]]; then
            CLIENT_NAME="$default_name"
            break
        fi

        CLIENT_NAME="$user_val"
        break
    done

    if [[ "$input_fd" -eq 3 ]]; then
        exec 3>&-
    fi
}

collect_dongle_count() {
    local input_fd
    local user_val=""
    local default_count=1

    if [[ -n "${NUM_DONGLES:-}" ]]; then
        if [[ "$NUM_DONGLES" =~ ^([1-9]|1[0-9]|2[0-5])$ ]]; then
            return 0
        fi
        echo "Error: NUM_DONGLES must be a number between 1 and 25." >&2
        return 1
    fi

    if [[ -t 0 ]]; then
        input_fd=0
    elif { exec 3<>/dev/tty; } 2>/dev/null; then
        input_fd=3
    elif [[ -t 1 ]] && { exec 3<>/proc/self/fd/1; } 2>/dev/null; then
        input_fd=3
    elif [[ -t 2 ]] && { exec 3<>/proc/self/fd/2; } 2>/dev/null; then
        input_fd=3
    else
        echo "Error: no interactive terminal is available for the dongle count prompt." >&2
        return 1
    fi

    while true; do
        printf "Enter the number of GSM dongles to activate on this server (1-25) [default: %s]: " "$default_count"
        if ! IFS= read -r -u "$input_fd" user_val; then
            if [[ "$input_fd" -eq 3 ]]; then
                exec 3>&-
            fi
            echo >&2
            echo "Error: could not read the GSM dongle count; installation stopped." >&2
            return 1
        fi

        user_val="${user_val//[[:space:]]/}"
        if [[ -z "$user_val" ]]; then
            NUM_DONGLES=$default_count
            break
        fi
        if [[ "$user_val" =~ ^([1-9]|1[0-9]|2[0-5])$ ]]; then
            NUM_DONGLES=$user_val
            break
        fi

        echo "Invalid input '$user_val'. Please enter a number between 1 and 25."
    done

    if [[ "$input_fd" -eq 3 ]]; then
        exec 3>&-
    fi
}

collect_default_setup() {
    local input_fd
    local user_val=""

    if [[ -n "${DEFAULT_SETUP:-}" ]]; then
        case "$(echo "$DEFAULT_SETUP" | tr '[:upper:]' '[:lower:]')" in
            y|yes|1|true)
                DEFAULT_SETUP="yes"
                return 0
                ;;
            n|no|0|false)
                DEFAULT_SETUP="no"
                return 0
                ;;
            *)
                DEFAULT_SETUP="no"
                return 0
                ;;
        esac
    fi

    if [[ -t 0 ]]; then
        input_fd=0
    elif { exec 3<>/dev/tty; } 2>/dev/null; then
        input_fd=3
    elif [[ -t 1 ]] && { exec 3<>/proc/self/fd/1; } 2>/dev/null; then
        input_fd=3
    elif [[ -t 2 ]] && { exec 3<>/proc/self/fd/2; } 2>/dev/null; then
        input_fd=3
    else
        DEFAULT_SETUP="no"
        return 0
    fi

    while true; do
        printf "Apply default setup (10 extensions 101-110, ring group 601, general inbound route)? [y/N]: "
        if ! IFS= read -r -u "$input_fd" user_val; then
            if [[ "$input_fd" -eq 3 ]]; then
                exec 3>&-
            fi
            DEFAULT_SETUP="no"
            break
        fi

        user_val="$(echo "$user_val" | tr '[:upper:]' '[:lower:]' | xargs)"
        if [[ -z "$user_val" || "$user_val" == "n" || "$user_val" == "no" ]]; then
            DEFAULT_SETUP="no"
            break
        elif [[ "$user_val" == "y" || "$user_val" == "yes" ]]; then
            DEFAULT_SETUP="yes"
            break
        fi

        echo "Invalid input '$user_val'. Please enter 'y' for yes or 'n' for no."
    done

    if [[ "$input_fd" -eq 3 ]]; then
        exec 3>&-
    fi
}

# Ask the 3 questions immediately
collect_default_setup
echo " Default setup: $DEFAULT_SETUP"
collect_client_name
echo " Client name: $CLIENT_NAME"
collect_dongle_count
echo " GSM dongles selected: $NUM_DONGLES"

# Save answers to the shared state file so subsequent scripts reuse them
mkdir -p "$(dirname "$SOKRAT_INPUTS_FILE")" 2>/dev/null || true
{
    echo "CLIENT_NAME='${CLIENT_NAME:-}'"
    echo "NUM_DONGLES='${NUM_DONGLES:-}'"
    echo "DEFAULT_SETUP='${DEFAULT_SETUP:-}'"
} > "$SOKRAT_INPUTS_FILE" 2>/dev/null || true
chmod 600 "$SOKRAT_INPUTS_FILE" 2>/dev/null || true

echo "=================================================================="
echo " Inputs saved! Starting unattended automated setup..."
echo " No further interaction is required."
echo "=================================================================="
echo ""

# ──────────────────────────────────────────────────────────────────────────────
# Step 2: Install git and clone repository
# ──────────────────────────────────────────────────────────────────────────────
if ! command -v git &>/dev/null; then
    echo "--> Installing git..."
    dnf install -y git 2>/dev/null || yum install -y git
fi

echo "--> Cloning Sokrat VOIP repository..."
if [ -d "$INSTALL_DIR/.git" ]; then
    echo "  Updating existing clone in $INSTALL_DIR..."
    git -C "$INSTALL_DIR" fetch --depth 1 origin "$REPO_BRANCH" 2>/dev/null || true
    git -C "$INSTALL_DIR" checkout "$REPO_BRANCH" 2>/dev/null || true
else
    mkdir -p "$(dirname "$INSTALL_DIR")"
    git clone --branch "$REPO_BRANCH" "$REPO_URL" "$INSTALL_DIR"
fi

# ──────────────────────────────────────────────────────────────────────────────
# Step 3: Run Master Appliance Installer & Sokrat Setup
# ──────────────────────────────────────────────────────────────────────────────
cd "$INSTALL_DIR/installer-bundle"

echo "--> Launching Master Issabel 5 & Asterisk 18 Setup..."
bash setup-issabel-asterisk.sh

echo "--> Launching Sokrat VOIP Application Setup..."
bash install-sokrat.sh

echo ""
echo "=================================================================="
echo " Sokrat VOIP Appliance Setup Complete!"
echo " Server IP: $(hostname -I | awk '{print $1}' || echo '<your_ip>')"
echo " Dashboard: http://$(hostname -I | awk '{print $1}' || echo '<your_ip>')/"
echo "=================================================================="
