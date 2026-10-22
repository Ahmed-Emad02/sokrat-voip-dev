#!/bin/bash
# ==============================================================================
# Sokrat VoIP - shared installation input
#
# The three questions of a fresh installation (default setup, client name and
# the number of GSM dongles) are asked at the VERY beginning, before the long
# package / Issabel steps, so the operator types them once and can watch the
# rest of the installation run.
#
# The answers are written to a state file, so the next script of the
# installation (install-sokrat.sh) picks them up instead of asking again.
#
# Usage:  source collect-install-inputs.sh && collect_install_inputs
# ==============================================================================

SOKRAT_INPUTS_FILE="${SOKRAT_INPUTS_FILE:-/var/lib/sokrat/install-inputs.env}"

# Collect required interactive input BEFORE any system checks or package
# installations. When the installer is piped to Bash, stdin contains the
# script, so read from the controlling terminal (or another terminal-backed
# descriptor) instead.
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
        echo "Download install.sh and run 'bash install.sh', or set NUM_DONGLES to a value from 1 to 25." >&2
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
                echo "Warning: Invalid DEFAULT_SETUP='$DEFAULT_SETUP', defaulting to 'no'." >&2
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

# Read the answers of an earlier step of the installation.
load_install_inputs() {
    [[ -f "$SOKRAT_INPUTS_FILE" ]] || return 1
    # shellcheck disable=SC1090
    source "$SOKRAT_INPUTS_FILE"
    return 0
}

# Remember the answers for the next step of the installation.
save_install_inputs() {
    mkdir -p "$(dirname "$SOKRAT_INPUTS_FILE")" 2>/dev/null || true
    {
        echo "CLIENT_NAME='${CLIENT_NAME:-}'"
        echo "NUM_DONGLES='${NUM_DONGLES:-}'"
        echo "DEFAULT_SETUP='${DEFAULT_SETUP:-}'"
    } > "$SOKRAT_INPUTS_FILE" 2>/dev/null || true
    chmod 600 "$SOKRAT_INPUTS_FILE" 2>/dev/null || true
}

# Ask the three installation questions (the ones already answered are kept).
collect_install_inputs() {
    load_install_inputs >/dev/null 2>&1 || true
    collect_default_setup
    echo " Default setup: $DEFAULT_SETUP"
    collect_client_name
    echo " Client name: $CLIENT_NAME"
    collect_dongle_count
    echo " GSM dongles selected: $NUM_DONGLES"
    save_install_inputs
}
