#!/bin/bash
# Shared chan_dongle install, source-build and reload-safety path.
#
# Sourced (never executed) by install.sh, installer-bundle/install-sokrat.sh and
# scripts/safe-upgrade.sh. Callers own the surrounding install steps; these
# helpers only materialize the pinned source, replace the module atomically and
# verify the running daemon.
#
# The native receive conditioner lives in asterisk/dongle_rx_condition.h and is
# included by asterisk/chan_dongle.patch. A source build without that header can
# never produce the working module, so it is a hard prerequisite here.

SOKRAT_CHAN_DONGLE_URL="${SOKRAT_CHAN_DONGLE_URL:-https://github.com/wdoekes/asterisk-chan-dongle.git}"
SOKRAT_CHAN_DONGLE_COMMIT="${SOKRAT_CHAN_DONGLE_COMMIT:-7db8e75bc2b7c81b173e1bb465e376e64a70319a}"

# Release-pinned module shipped in installer-bundle/binaries/chan_dongle.so.
# This digest is mandatory for bundle installs only: compiler output from a
# source build is not byte-identical and is never compared with it.
SOKRAT_CHAN_DONGLE_BUNDLE_SHA256="745e9dbf5bbcb815c04d5fa11a1e83c5eb110dfeb204534436a2054f6ed019dd"

# Strip URL userinfo (user:password@) from any line passed on stdin. Used for
# every origin string that reaches installer output, including git's own
# diagnostics; a credential must never be echoed or logged.
_dongle_module_redact_origin() {
    sed -E 's#(://)[^/[:space:]]*@#\1***@#g'
}

dongle_module_install_file() {
    local source="${1:-}"
    local modules_dir="${2:-}"
    local label="${3:-bundle binary}"
    local target tmp

    if [ -z "$source" ] || [ ! -f "$source" ]; then
        echo "  ERROR: chan_dongle module not found: ${source:-<empty>}" >&2
        return 1
    fi
    if [ -z "$modules_dir" ]; then
        echo "  ERROR: chan_dongle modules directory is required" >&2
        return 1
    fi
    if [ "$(od -An -tx1 -N4 "$source" 2>/dev/null | tr -d ' \n')" != "7f454c46" ]; then
        echo "  ERROR: $source is not an ELF module (truncated or LFS placeholder)" >&2
        return 1
    fi
    if ! mkdir -p "$modules_dir"; then
        echo "  ERROR: cannot create modules directory: $modules_dir" >&2
        return 1
    fi

    target="$modules_dir/chan_dongle.so"
    if [ -f "$target" ] && cmp -s "$source" "$target"; then
        echo "  chan_dongle.so already matches $label in $modules_dir (preserved live inode)"
        return 0
    fi

    # Keep an immediate rollback copy plus the first .bak-install alias. Never
    # overwrite a known-good rollback with a later build.
    if [ -f "$target" ]; then
        cp -a "$target" "$target.bak-$(date +%Y%m%d_%H%M%S)" 2>/dev/null || true
        if [ ! -f "$target.bak-install" ]; then
            cp -a "$target" "$target.bak-install" 2>/dev/null || true
        fi
    fi

    tmp="$target.tmp.$$"
    if ! cp "$source" "$tmp"; then
        rm -f "$tmp"
        echo "  ERROR: cannot stage $source for $target" >&2
        return 1
    fi
    if ! chmod 644 "$tmp"; then
        rm -f "$tmp"
        echo "  ERROR: cannot set permissions on $tmp" >&2
        return 1
    fi
    if ! mv -f "$tmp" "$target"; then
        rm -f "$tmp"
        echo "  ERROR: cannot replace $target" >&2
        return 1
    fi
    if ! cmp -s "$source" "$target"; then
        echo "  ERROR: $target does not match $source after replacement" >&2
        return 1
    fi

    echo "  chan_dongle.so installed from $label into $modules_dir (atomic update)"
    return 0
}

# Install the release-bundled module. The bundled artifact is byte-identical on
# every host, so a bundle that is a valid ELF but not the release-pinned build
# is refused before anything is copied, backed up or reloaded.
dongle_module_install_bundle() {
    local source="${1:-}"
    local modules_dir="${2:-}"
    local actual

    if [ -z "$source" ] || [ ! -f "$source" ]; then
        echo "  ERROR: bundled chan_dongle module not found: ${source:-<empty>}" >&2
        return 1
    fi
    if [ -z "$modules_dir" ]; then
        echo "  ERROR: chan_dongle modules directory is required" >&2
        return 1
    fi
    if ! command -v sha256sum >/dev/null 2>&1; then
        echo "  ERROR: sha256sum is required to verify the bundled chan_dongle module" >&2
        return 1
    fi
    actual=$(sha256sum "$source" 2>/dev/null | awk '{print $1}') || actual=""
    if [ "$actual" != "$SOKRAT_CHAN_DONGLE_BUNDLE_SHA256" ]; then
        echo "  ERROR: $source is not the release-pinned chan_dongle module" >&2
        echo "  Refusing a stale or modified bundle before installation; expected SHA256 $SOKRAT_CHAN_DONGLE_BUNDLE_SHA256, found ${actual:-<unreadable>}" >&2
        return 1
    fi

    dongle_module_install_file "$source" "$modules_dir" "release-bundled binary"
}

# Clone origin into an empty destination and detach at the exact commit. The
# caller's source tree is only read by git; no checkout/reset/clean is performed
# in it. Used by the tests against a local git repository and by installers
# against the pinned upstream commit.
dongle_module_materialize_source() {
    local origin="${1:-}"
    local commit="${2:-}"
    local destination="${3:-}"
    local actual safe_origin err

    if [ -z "$origin" ]; then
        echo "  ERROR: chan_dongle source origin is required" >&2
        return 1
    fi
    safe_origin=$(printf '%s\n' "$origin" | _dongle_module_redact_origin)
    case "$commit" in
        [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) ;;
        *)
            echo "  ERROR: chan_dongle commit must be a full 40-hex SHA: ${commit:-<empty>}" >&2
            return 1
            ;;
    esac
    if [ -z "$destination" ]; then
        echo "  ERROR: chan_dongle destination is required" >&2
        return 1
    fi
    if ! command -v git >/dev/null 2>&1; then
        echo "  ERROR: git is required to materialize pinned chan_dongle source" >&2
        return 1
    fi
    if ! mkdir -p "$destination"; then
        echo "  ERROR: cannot create chan_dongle staging directory: $destination" >&2
        return 1
    fi
    if [ -n "$(ls -A "$destination" 2>/dev/null)" ]; then
        echo "  ERROR: chan_dongle staging directory is not empty: $destination" >&2
        return 1
    fi

    if ! err=$(git clone --quiet "$origin" "$destination" 2>&1); then
        if [ -n "$err" ]; then
            printf '%s\n' "$err" | _dongle_module_redact_origin >&2
        fi
        echo "  ERROR: cannot clone $safe_origin for a pinned chan_dongle build" >&2
        return 1
    fi
    if ! git -C "$destination" cat-file -e "$commit^{commit}" 2>/dev/null; then
        if ! err=$(git -C "$destination" fetch --quiet origin "$commit" 2>&1); then
            if [ -n "$err" ]; then
                printf '%s\n' "$err" | _dongle_module_redact_origin >&2
            fi
            echo "  ERROR: commit $commit is not available from $safe_origin" >&2
            return 1
        fi
    fi
    if ! git -C "$destination" checkout --quiet --detach "$commit"; then
        echo "  ERROR: cannot check out chan_dongle commit $commit" >&2
        return 1
    fi
    actual=$(git -C "$destination" rev-parse HEAD 2>/dev/null) || actual=""
    if [ "$actual" != "$commit" ]; then
        echo "  ERROR: pinned chan_dongle checkout is $actual, expected $commit" >&2
        return 1
    fi
    echo "  Materialized chan_dongle $commit from $safe_origin"
    return 0
}

# Prefer a local clone that already contains the pinned commit; otherwise the
# caller gets the canonical upstream URL. The local tree is only read.
dongle_module_source_origin() {
    local local_dir="${1:-}"
    if [ -n "$local_dir" ] && [ -d "$local_dir/.git" ] \
        && command -v git >/dev/null 2>&1 \
        && git -C "$local_dir" cat-file -e "$SOKRAT_CHAN_DONGLE_COMMIT^{commit}" 2>/dev/null; then
        printf '%s\n' "$local_dir"
    else
        printf '%s\n' "$SOKRAT_CHAN_DONGLE_URL"
    fi
}

dongle_module_build_source() {
    local origin="${1:-}"
    local commit="${2:-}"
    local patch_file="${3:-}"
    local header_file="${4:-}"
    local modules_dir="${5:-}"
    local astversion="${6:-18.19.0}"
    local staging log_file

    if [ -z "$header_file" ] || [ ! -f "$header_file" ]; then
        echo "  ERROR: missing native conditioner header: ${header_file:-<empty>}" >&2
        echo "  chan_dongle.patch includes dongle_rx_condition.h; refusing to build without it." >&2
        return 1
    fi
    if [ -z "$patch_file" ] || [ ! -f "$patch_file" ]; then
        echo "  ERROR: chan_dongle patch not found: ${patch_file:-<empty>}" >&2
        return 1
    fi
    if [ -z "$origin" ]; then
        echo "  ERROR: chan_dongle source origin is required" >&2
        return 1
    fi

    # Callers may pass relative paths; resolve them before changing directory.
    case "$patch_file" in
        /*) ;;
        *) patch_file="$(cd "$(dirname "$patch_file")" && pwd)/$(basename "$patch_file")" || return 1 ;;
    esac
    case "$header_file" in
        /*) ;;
        *) header_file="$(cd "$(dirname "$header_file")" && pwd)/$(basename "$header_file")" || return 1 ;;
    esac

    # Build beside a local origin when possible: it is executable and on the
    # same filesystem. A URL origin uses TMPDIR.
    case "$origin" in
        *://*|git@*) staging=$(mktemp -d "${TMPDIR:-/tmp}/sokrat-dongle-build.XXXXXX" 2>/dev/null) ;;
        *) staging=$(mktemp -d "$(dirname "$origin")/.sokrat-dongle-build.XXXXXX" 2>/dev/null) ;;
    esac
    if [ -z "$staging" ]; then
        staging=$(mktemp -d "${TMPDIR:-/tmp}/sokrat-dongle-build.XXXXXX" 2>/dev/null) || {
            echo "  ERROR: cannot create a temporary build directory" >&2
            return 1
        }
    fi
    log_file="$staging/build.log"

    if ! dongle_module_materialize_source "$origin" "$commit" "$staging"; then
        rm -rf "$staging"
        return 1
    fi

    if ! (
        cd "$staging" || exit 1

        if command -v patch >/dev/null 2>&1; then
            if patch -p1 -N --dry-run < "$patch_file" >/dev/null 2>&1; then
                patch -p1 < "$patch_file" >/dev/null || exit 1
                echo "  Applied Sokrat chan_dongle patch"
            elif patch -p1 -R --dry-run < "$patch_file" >/dev/null 2>&1; then
                echo "  Sokrat chan_dongle patch already applied"
            else
                echo "  ERROR: chan_dongle patch does not apply to $commit" >&2
                exit 1
            fi
        elif git apply --check "$patch_file" >/dev/null 2>&1; then
            git apply "$patch_file" || exit 1
            echo "  Applied Sokrat chan_dongle patch"
        elif git apply --reverse --check "$patch_file" >/dev/null 2>&1; then
            echo "  Sokrat chan_dongle patch already applied"
        else
            echo "  ERROR: chan_dongle patch does not apply to $commit" >&2
            exit 1
        fi

        # Apply the separate CLCC answer-polling fix after the main patch.
        # The patch is optional for older bundles but mandatory for source
        # builds; keep it separate so the large audio patch remains unchanged.
        clcc_patch="${patch_file%/*}/chan_dongle-clcc-poll.patch"
        if [ -f "$clcc_patch" ] && ! grep -q "Huawei firmware does not reliably emit" chan_dongle.c 2>/dev/null; then
            if command -v patch >/dev/null 2>&1; then
                patch -p1 -N < "$clcc_patch" >/dev/null 2>&1 || \
                    echo "  WARNING: chan_dongle CLCC polling patch did not apply" >&2
            elif git apply --check "$clcc_patch" >/dev/null 2>&1; then
                git apply "$clcc_patch" >/dev/null 2>&1 || \
                    echo "  WARNING: chan_dongle CLCC polling patch did not apply" >&2
            fi
        fi

        # Drop stale PCM in the shared TX mixbuffer when a call detaches or a
        # new call activates. This prevents previous-call audio from playing
        # before/over the next announcement on all dongles.
        tx_patch="${patch_file%/*}/chan_dongle-tx-buffer-reset.patch"
        if [ -f "$tx_patch" ] && ! grep -q "Drop PCM left in the shared TX ring" channel.c 2>/dev/null; then
            if command -v patch >/dev/null 2>&1; then
                patch -p1 -N < "$tx_patch" >>"$log_file" 2>&1 || {
                    echo "  ERROR: chan_dongle TX buffer reset patch did not apply" >&2
                    exit 1
                }
            elif git apply --check "$tx_patch" >/dev/null 2>&1; then
                git apply "$tx_patch" || {
                    echo "  ERROR: chan_dongle TX buffer reset patch did not apply" >&2
                    exit 1
                }
            else
                echo "  ERROR: chan_dongle TX buffer reset patch does not apply" >&2
                exit 1
            fi
            echo "  Applied Sokrat chan_dongle TX buffer reset patch"
        fi

        # Some firmware reports voice support while its PCM path is disabled.
        # Enable voice explicitly for every dongle; unsupported devices fail
        # through the bounded retry path without aborting initialization.
        voice_patch="${patch_file%/*}/chan_dongle-voice-enable.patch"
        if [ -f "$voice_patch" ] && ! grep -q "E173_VOICE_MAX_ATTEMPTS" at_response.c 2>/dev/null; then
            if command -v patch >/dev/null 2>&1; then
                patch -p1 -N < "$voice_patch" >>"$log_file" 2>&1 || {
                    echo "  ERROR: chan_dongle voice enable patch did not apply" >&2
                    exit 1
                }
            elif git apply --check "$voice_patch" >/dev/null 2>&1; then
                git apply "$voice_patch" || {
                    echo "  ERROR: chan_dongle voice enable patch did not apply" >&2
                    exit 1
                }
            else
                echo "  ERROR: chan_dongle voice enable patch does not apply" >&2
                exit 1
            fi
            echo "  Applied Sokrat chan_dongle voice enable patch"
        fi

        cp "$header_file" ./dongle_rx_condition.h || exit 1

        if [ ! -x ./configure ] && [ -x ./bootstrap ]; then
            ./bootstrap >>"$log_file" 2>&1 || exit 1
        fi
        if [ -x ./configure ]; then
            ./configure --with-astversion="$astversion" >>"$log_file" 2>&1 \
                || ./configure >>"$log_file" 2>&1 \
                || exit 1
        elif [ ! -f Makefile ]; then
            echo "  ERROR: no configure script or Makefile at $commit" >&2
            exit 1
        fi

        make clean >>"$log_file" 2>&1 || true
        rm -f chan_dongle.so
        if ! make -j"$(nproc 2>/dev/null || echo 1)" >>"$log_file" 2>&1; then
            echo "  ERROR: chan_dongle build failed; last output:" >&2
            tail -n 20 "$log_file" >&2 || true
            exit 1
        fi
        if [ ! -f chan_dongle.so ]; then
            echo "  ERROR: chan_dongle build finished without producing chan_dongle.so" >&2
            exit 1
        fi
    ); then
        rm -rf "$staging"
        return 1
    fi

    # Upstream `make install` strips the module; keep source builds equivalent.
    if command -v strip >/dev/null 2>&1; then
        strip "$staging/chan_dongle.so" >>"$log_file" 2>&1 || true
    fi

    if ! dongle_module_install_file "$staging/chan_dongle.so" "$modules_dir" "patched source build"; then
        rm -rf "$staging"
        return 1
    fi
    rm -rf "$staging"
    echo "  chan_dongle.so built from pinned source and installed into $modules_dir"
    return 0
}

_dongle_module_status() {
    local ast="${1:-asterisk}"
    local output
    output=$("$ast" -rx "module show like chan_dongle.so" 2>/dev/null) || return 1
    printf '%s\n' "$output" | awk '$1 == "chan_dongle.so" {
        for (i = 1; i <= NF; i++) if ($i == "Not" && $(i + 1) == "Running") { print "NotRunning"; exit }
        for (i = 1; i <= NF; i++) if ($i == "Running") { print "Running"; exit }
    }'
}

dongle_module_require_idle() {
    local ast="${1:-asterisk}"
    local output active

    if ! command -v pgrep >/dev/null 2>&1; then
        echo "  ERROR: cannot determine whether Asterisk is running; refusing an unsafe dongle reload" >&2
        return 1
    fi
    if ! pgrep -x asterisk >/dev/null 2>&1; then
        return 0
    fi
    if ! command -v "$ast" >/dev/null 2>&1; then
        echo "  ERROR: Asterisk is running but its CLI is unavailable; refusing an unsafe dongle reload" >&2
        return 1
    fi
    if ! output=$("$ast" -rx "core show channels" 2>/dev/null); then
        echo "  ERROR: cannot determine active channels; refusing an unsafe dongle reload" >&2
        return 1
    fi
    active=$(printf '%s\n' "$output" | awk '/active channels|active calls?/ {print $1; exit}')
    case "$active" in
        ''|*[!0-9]*)
            echo "  ERROR: cannot determine active channels; refusing an unsafe dongle reload" >&2
            return 1
            ;;
        0)
            return 0
            ;;
    esac
    echo "  ERROR: $active active channel(s); refusing to unload or restart chan_dongle. Retry when idle." >&2
    return 1
}

# Load optional func_rnnoise only when it is not already running. Asterisk
# returns "Unable to load module" when a module is already loaded, which is
# commonly mistaken for a real failure by installers.
dongle_module_ensure_func_rnnoise() {
    local ast="${1:-asterisk}"
    local module_status=""

    if ! command -v "$ast" >/dev/null 2>&1; then
        echo "  WARNING: Asterisk CLI unavailable; func_rnnoise.so load is unverified" >&2
        return 1
    fi

    module_status=$("$ast" -rx "module show like func_rnnoise.so" 2>/dev/null || true)
    if printf '%s\n' "$module_status" | grep -Eq 'func_rnnoise\.so[[:space:]].*Running'; then
        echo "  func_rnnoise.so already running"
        return 0
    fi

    if "$ast" -rx "module load func_rnnoise.so" >/dev/null 2>&1; then
        echo "  func_rnnoise.so loaded into Asterisk"
        return 0
    fi

    # The load command can race the CLI or report "already loaded" as a
    # failure. Re-read the module table before treating this as a real error.
    module_status=$("$ast" -rx "module show like func_rnnoise.so" 2>/dev/null || true)
    if printf '%s\n' "$module_status" | grep -Eq 'func_rnnoise\.so[[:space:]].*Running'; then
        echo "  func_rnnoise.so already running"
        return 0
    fi

    echo "  WARNING: func_rnnoise.so failed to load; RNNoise remains optional" >&2
    return 1
}

dongle_module_wait_running() {
    local timeout="${1:-20}"
    local ast="${2:-asterisk}"
    local waited=0
    local status=""

    if ! command -v "$ast" >/dev/null 2>&1; then
        echo "  ERROR: Asterisk CLI is unavailable; chan_dongle reload is unverified" >&2
        return 1
    fi
    if ! command -v pgrep >/dev/null 2>&1; then
        echo "  ERROR: cannot determine whether Asterisk is running; chan_dongle reload is unverified" >&2
        return 1
    fi

    while :; do
        # systemctl restart returns before a Type=simple Asterisk process is
        # necessarily visible, and the CLI socket can lag the process. Poll
        # both until the timeout instead of failing on the first sample.
        if ! pgrep -x asterisk >/dev/null 2>&1; then
            status="Asterisk process starting"
        elif ! status=$(_dongle_module_status "$ast"); then
            # A Type=simple service can start before its CLI socket is ready.
            status="CLI unavailable"
        fi
        if [ "$status" = "Running" ]; then
            echo "  chan_dongle.so is running"
            return 0
        fi
        if [ "$waited" -ge "$timeout" ]; then
            break
        fi
        sleep 1
        waited=$((waited + 1))
    done

    echo "  ERROR: chan_dongle.so is not running after ${timeout}s (status: ${status:-not loaded})" >&2
    return 1
}

dongle_module_wait_stopped() {
    local timeout="${1:-10}"
    local ast="${2:-asterisk}"
    local waited=0
    local status=""

    if ! command -v "$ast" >/dev/null 2>&1 || ! command -v pgrep >/dev/null 2>&1 \
        || ! pgrep -x asterisk >/dev/null 2>&1; then
        return 0
    fi

    while :; do
        if ! status=$(_dongle_module_status "$ast"); then
            echo "  ERROR: cannot query chan_dongle module state" >&2
            return 1
        fi
        if [ "$status" != "Running" ]; then
            echo "  chan_dongle.so is unloaded"
            return 0
        fi
        if [ "$waited" -ge "$timeout" ]; then
            break
        fi
        sleep 1
        waited=$((waited + 1))
    done

    echo "  ERROR: chan_dongle.so is still running after ${timeout}s; refusing to claim a reload" >&2
    return 1
}
