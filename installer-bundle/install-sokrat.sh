#!/bin/bash
# Issabel Dashboard — Automated installer for Issabel 5 / Asterisk 18
# Run as root on a fresh Issabel 5 installation.
# Usage: bash install.sh

set -euo pipefail

export PATH="/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin:${PATH:-}"

INSTALL_DIR=/opt/sokrat-voip
REPO_URL=https://github.com/Ahmed-Emad02/sokrat-voip-dev.git
REPO_BRANCH=main
SOFTPHONE_DIR=/opt/sokrat-softphone
SOFTPHONE_REPO_URL=https://github.com/Ahmed-Emad02/sokrat-voice.git
SOFTPHONE_REPO_BRANCH=main
PUSH_GATEWAY_DIR=/opt/sokrat-push-gateway
PUSH_GATEWAY_REPO=https://github.com/Ahmed-Emad02/sokrat-push-gateway.git
NODE_SETUP_URL=https://rpm.nodesource.com/setup_22.x
MYSQL_ROOT_PWD=$(grep mysqlrootpwd /etc/issabel.conf 2>/dev/null | cut -d= -f2- | xargs || true)
echo "============================================"
echo " Sokrat VOIP Installer v1.0.4"
echo " Target: Asterisk 18"
echo "============================================"
# Collect required interactive input BEFORE any system checks or package installations.
# When the installer is piped to Bash, stdin contains the script, so read from the
# controlling terminal (or another terminal-backed descriptor) instead.
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

collect_default_setup
echo " Default setup: $DEFAULT_SETUP"
collect_client_name
echo " Client name: $CLIENT_NAME"
collect_dongle_count
echo " GSM dongles selected: $NUM_DONGLES"
echo "============================================"
echo ""

# Configure machine hostname from client name
SYSTEM_HOSTNAME=$(echo "$CLIENT_NAME" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g' | sed -E 's/^-+|-+$//g')
if [[ -z "$SYSTEM_HOSTNAME" ]]; then
    SYSTEM_HOSTNAME="sokrat"
fi
echo "Configuring machine hostname to '$SYSTEM_HOSTNAME'..."
echo "$SYSTEM_HOSTNAME" > /etc/hostname 2>/dev/null || true
hostname "$SYSTEM_HOSTNAME" 2>/dev/null || true
hostnamectl set-hostname "$SYSTEM_HOSTNAME" 2>/dev/null || true

# Fix virtual/physical NIC TCP segmentation offloading corruption and MTU on Rocky 8
for dev in $(ip -o link show | awk -F': ' '{print $2}' | grep -vE '^(lo|docker|veth)'); do
    ethtool -K "$dev" rx off tx off tso off gso off gro off lro off 2>/dev/null || true
    ip link set dev "$dev" mtu 1400 2>/dev/null || true
done

# Ensure reliable public DNS resolution for GitHub, npm, and system repositories
grep -q "8.8.8.8" /etc/resolv.conf 2>/dev/null || echo -e "nameserver 8.8.8.8\nnameserver 1.1.1.1" >> /etc/resolv.conf
# ──────────────────────────────────────────────
# Step 1 — System Packages + Disable Fail2Ban + Install Sokrat MOTD
# ──────────────────────────────────────────────
echo "[1/14] Checking system prerequisites..."
# Packages already provided by installer-bundle (sox, sqlite, picotts, net-tools, nano)

# Announcements in Issabel use picotts.agi, which requires both sox and pico2wave.
PICO_AGI_SOURCE=/var/www/html/admin/modules/announcement/agi-bin/picotts.agi
PICO_AGI_TARGET=/var/lib/asterisk/agi-bin/picotts.agi
if ! command -v pico2wave &>/dev/null; then
    echo "  Error: picotts installed without the required pico2wave binary" >&2
    exit 1
fi

write_embedded_picotts_agi() {
    local target="$1"
    install -d -o asterisk -g asterisk -m 0755 "$(dirname "$target")"
    cat << 'EOF' > "$target"
#!/usr/bin/env perl

#
# AGI script that uses the SVOX Pico TTS text to speech engine.
#
# Copyright (C) 2015, Steven Mirabito <smirabito@csh.rit.edu>
# Copyright (C) 2011 - 2015, Lefteris Zafiris <zaf.000@gmail.com>
#
# This program is free software, distributed under the terms of
# the GNU General Public License Version 2. See the COPYING file
# at the top of the source tree.
#
# -----
# Usage
# -----
# agi(picotts.agi,"text",[language],[intkey],[speed]): This will invoke the Pico TTS
# engine, render the text string to speech and play it back to the user.
# If 'intkey' is set the script will wait for user input. Any given interrupt keys will
# cause the playback to immediately terminate and the dialplan to proceed to the
# matching extension (this is mainly for use in IVR, see README for examples).
#
# The script invokes PicoSpeaker in order to get the voice data,
# which then stores in a local cache (by default /tmp/) for future use.
#
# Parameters like default language, sample rate, caching and cache dir
# can be set up by altering the following variables:
#
# Default langeuage: $lang
# Speech rate:       $rate
# Voice pitch:       $pitch
# Chace:             $usecache
# Chache directory:  $cachedir
# SoX Version:       $sox_ver
#

use warnings;
use strict;
use Encode qw(decode encode);
use File::Temp qw(tempfile);
use File::Copy qw(move);
use File::Path qw(mkpath);
use Digest::MD5 qw(md5_hex);
$| = 1;

# ----------------------------- #
#   User defined parameters:    #
# ----------------------------- #
# Default language              #
my $lang = "en-US";

# Output speed factor           #
my $speed = 1;

# Use of cache mechanism        #
my $usecache = 1;

# Cache directory path          #
my $cachedir = "/tmp";

# Output audio sample rate      #
# Leave blank to auto-detect    #
my $samplerate = "";

# SoX Version                   #
# Leave blank to auto-detect    #
my $sox_ver = "14";

# Verbose debugging messages    #
my $debug = 0;

# ----------------------------- #

my %AGI;
my @text;
my $fh;
my $tmpname;
my $fexten;
my $sox;
my $pico2wave;
my $intkey  = "";
my $tmpdir  = "/tmp";
my $maxlen  = 4096;
my $timeout = 10;

# Store AGI input #
($AGI{arg_1}, $AGI{arg_2}, $AGI{arg_3}, $AGI{arg_4}) = @ARGV;
while (<STDIN>) {
	chomp;
	last if (!length);
	$AGI{$1} = $2 if (/^agi_(\w+)\:\s+(.*)$/);
}
my $name = " -- $AGI{request}:";

# Sanitising input #
$AGI{arg_1} = decode('utf8', $AGI{arg_1});
for ($AGI{arg_1}) {
	s/[\\|*~<>^\(\)\[\]\{\}[:cntrl:]]/ /g;
	s/\s+/ /g;
	s/^\s|\s$//g;
	die "$name No text passed for synthesis.\n" if (!length);
	# Split input to comply with google tts requirements #
	$_ .= "." unless (/^.+[.,?!:;]$/);
	@text = /.{1,150}[.,?!:;]|.{1,150}\s/g;
}
my $lines = @text;

# Setting language, interrupt keys and speed rate #
if (length($AGI{arg_2})) {
	if ($AGI{arg_2} =~ /^[a-zA-Z]{2}(-[a-zA-Z]{2,6})?$/) {
		$lang = $AGI{arg_2};
	} else {
		warn "$name Invalid language setting. Using default.\n";
	}
}

if (length($AGI{arg_3})) {
	$intkey = "0123456789#*" if ($AGI{arg_3} eq "any");
	$intkey = $AGI{arg_3}    if ($AGI{arg_3} =~ /^[0-9*#]+$/);
}

if (length($AGI{arg_4})) {
	$speed = $AGI{arg_4} if ($AGI{arg_4} =~ /^\d+(\.\d+)?$/);
}

# Check cache path size: dir length + md5 + file extension #
if ($usecache && ((length($cachedir) + 32 + 6) < $maxlen)) {
	mkpath("$cachedir") unless (-d "$cachedir");
} else {
	warn "$name Cache path size exceeds limit. Disabling cache.\n";
	$usecache = 0;
}

# Answer channel if not already answered #
print "CHANNEL STATUS\n";
my @result = checkresponse();
if ($result[0] == 4) {
	print "ANSWER\n";
	@result = checkresponse();
	if ($result[0] != 0) {
		die "$name Failed to answer channel.\n";
	}
}

# Setting filename extension according to sample rate. #
if    (!$samplerate)         { ($fexten, $samplerate) = detect_format(); }
elsif ($samplerate == 12000) { $fexten = "sln12"; }
elsif ($samplerate == 16000) { $fexten = "sln16"; }
elsif ($samplerate == 32000) { $fexten = "sln32"; }
elsif ($samplerate == 44100) { $fexten = "sln44"; }
elsif ($samplerate == 48000) { $fexten = "sln48"; }
else                         { ($fexten, $samplerate) = ("sln", 8000); }

for (my $i=0; $i < $lines; $i++) {
	my $filename;
	my $res;
	my $line = encode('utf8', $text[$i]);
	$line =~ s/^\s+|\s+$//g;
	next if (length($line) == 0);
	if ($debug) {
		warn "$name Text passed for synthesis: $line\n",
			"$name Language: $lang, Interrupt keys: $intkey, Sample rate: $samplerate\n",
			"$name Speed: $speed, Caching: $usecache, Cache dir: $cachedir\n";
	}
	if ($usecache) {
		$filename = md5_hex("$line.$lang.$speed");
		# Stream file from cache if it exists #
		if (-r "$cachedir/$filename.$fexten") {
			warn "$name File already in cache.\n" if ($debug);
			$res = playback("$cachedir/$filename", $intkey);
			die if ($res < 0);
			last if ($res > 0);
			next;
		}
	}

	# Handle interrupts #
	$SIG{'INT'} = \&int_handler;
	$SIG{'HUP'} = \&int_handler;

	($fh, $tmpname) = tempfile("pico_XXXXXX", DIR => $tmpdir, UNLINK => 1);
	
	# Detect required programs #
	if (!$sox || !$pico2wave) {
		$sox    = `/usr/bin/which sox`;
		$pico2wave = `/usr/bin/which pico2wave`;
		# Abort if required programs not found. #
		die "$name sox or pico2wave is missing. Aborting.\n" if (!$sox || !$pico2wave);
		chomp($sox, $pico2wave);
	}
	if (!$sox_ver) {
		$sox_ver = (system("$sox --version > /dev/null 2>&1") == 0) ? 14 : 12;
		warn "$name Found sox version $sox_ver in: $sox, pico2wave in: $pico2wave\n" if ($debug);
	}

	# Convert text to speech and store it in a temporary file #
	system($pico2wave, "-l", $lang, "-w", "$tmpname.wav", $line) == 0
		or die "$name $pico2wave failed: $?\n";
	
	# Convert wav file to 16bit 8Khz or 16kHz mono raw #
	my @soxargs = get_sox_args("$tmpname.wav", "$tmpname.$fexten");
	system(@soxargs) == 0 or die "$name $sox failed: $?\n";
	unlink "$tmpname.wav";

	# Playback and save file in cache #
	$res = playback($tmpname, $intkey);
	die if ($res < 0);
	if ($usecache) {
		warn "$name Saving file $filename to cache\n" if ($debug);
		move("$tmpname.$fexten", "$cachedir/$filename.$fexten");
	} else {
		unlink "$tmpname.$fexten";
	}
	last if ($res > 0);
}
exit;

sub checkresponse {
	my $input = <STDIN>;
	my @values;

	chomp $input;
	if ($input =~ /^200 result=(-?\d+)\s?(.*)$/) {
		warn "$name Command returned: $input\n" if ($debug);
		@values = ("$1", "$2");
	} else {
		$input .= <STDIN> if ($input =~ /^520-Invalid/);
		warn "$name Unexpected result: $input\n";
		@values = (-1, -1);
	}
	return @values;
}

sub playback {
	my ($file, $keys) = @_;
	my @response;

	print "STREAM FILE $file \"$keys\"\n";
	@response = checkresponse();
	if ($response[0] >= 32 && chr($response[0]) =~ /[\w*#]/) {
		warn "$name Got digit ", chr($response[0]), "\n" if ($debug);
		print "SET EXTENSION ", chr($response[0]), "\n";
		checkresponse();
		print "SET PRIORITY 1\n";
		checkresponse();
	} elsif ($response[0] == -1) {
		warn "$name Failed to play $file.\n";
	}
	return $response[0];
}

sub detect_format {
# Detect the sound format used #
	my @format;
	print "GET FULL VARIABLE \${CHANNEL(audionativeformat)}\n";
	my @reply = checkresponse();
	for ($reply[1]) {
		if    (/(silk|sln)12/)                    { @format = ("sln12", 12000); }
		elsif (/(speex|slin|silk)16|g722|siren7/) { @format = ("sln16", 16000); }
		elsif (/(speex|slin|celt)32|siren14/)     { @format = ("sln32", 32000); }
		elsif (/(celt|slin)44/)                   { @format = ("sln44", 44100); }
		elsif (/(celt|slin)48/)                   { @format = ("sln48", 48000); }
		else                                      { @format = ("sln",    8000); }
	}
	return @format;
}

sub get_sox_args {
# Set the appropiate sox cli arguments #
	my ($source_file, $dest_file) = @_;

	my @soxargs = ($sox, $source_file, "-q", "-r", $samplerate, "-t", "raw", $dest_file);
	if ($speed != 1) {
		if ($sox_ver >= 14) {
			push(@soxargs, ("tempo", "-s", $speed));
		} else {
			push(@soxargs, ("stretch", 1/$speed, "80"));
		}
	}
	return @soxargs;
}

sub int_handler {
	die "$name Interrupt signal received, terminating...\n";
}

END {
	if ($tmpname) {
		warn "$name Cleaning temp files.\n" if ($debug);
		unlink glob "$tmpname*";
	}
}
EOF
    chmod 0755 "$target"
}

# Ensure picotts.agi exists in both announcement module and Asterisk agi-bin
if [ ! -f "$PICO_AGI_SOURCE" ] && [ ! -f "$PICO_AGI_TARGET" ]; then
    echo "  Provisioning picotts.agi to $PICO_AGI_SOURCE and $PICO_AGI_TARGET..."
    write_embedded_picotts_agi "$PICO_AGI_SOURCE"
    write_embedded_picotts_agi "$PICO_AGI_TARGET"
elif [ -f "$PICO_AGI_SOURCE" ] && [ ! -f "$PICO_AGI_TARGET" ]; then
    install -d -o asterisk -g asterisk -m 0755 "$(dirname "$PICO_AGI_TARGET")"
    install -o asterisk -g asterisk -m 0755 "$PICO_AGI_SOURCE" "$PICO_AGI_TARGET"
elif [ -f "$PICO_AGI_TARGET" ] && [ ! -f "$PICO_AGI_SOURCE" ]; then
    install -d -o asterisk -g asterisk -m 0755 "$(dirname "$PICO_AGI_SOURCE")"
    install -o asterisk -g asterisk -m 0755 "$PICO_AGI_TARGET" "$PICO_AGI_SOURCE"
else
    install -d -o asterisk -g asterisk -m 0755 "$(dirname "$PICO_AGI_TARGET")"
    install -o asterisk -g asterisk -m 0755 "$PICO_AGI_SOURCE" "$PICO_AGI_TARGET"
fi
perl -c "$PICO_AGI_TARGET" >/dev/null 2>&1

PICO_TEST_WAV="/tmp/sokrat-pico-test-$$.wav"
if ! pico2wave -l en-US -w "$PICO_TEST_WAV" "Sokrat VoIP" || [ ! -s "$PICO_TEST_WAV" ]; then
    rm -f "$PICO_TEST_WAV"
    echo "  Error: Pico TTS synthesis check failed" >&2
    exit 1
fi
rm -f "$PICO_TEST_WAV"
echo "  Announcement TTS dependencies verified"
echo "  System packages installed"
# fail2ban is optional; disable if the unit exists
if systemctl is-enabled fail2ban &>/dev/null; then
    systemctl disable --now fail2ban
    echo "  fail2ban disabled"
else
    echo "  fail2ban not present, skipping"
fi

# ──────────────────────────────────────────────
# Step 2 — Install Node.js 22
# ──────────────────────────────────────────────
echo "[2/14] Installing Node.js 22..."
if command -v node &>/dev/null; then
    echo "  Node.js already installed: $(node -v)"
elif [ -f "/tmp/sokrat-repo/installer-bundle/binaries/node" ]; then
    echo "  Installing Node.js from installer-bundle..."
    cp "/tmp/sokrat-repo/installer-bundle/binaries/node" /usr/local/bin/node
    chmod +x /usr/local/bin/node
    echo "  Node.js installed: $(/usr/local/bin/node -v)"
else
    curl -fsSL -o /tmp/nodesetup.sh "$NODE_SETUP_URL"
    bash /tmp/nodesetup.sh
    yum install -y nodejs
    rm -f /tmp/nodesetup.sh
fi

# ──────────────────────────────────────────────
# Step 3 — Clone the Repository
# ──────────────────────────────────────────────
echo "[3/14] Cloning repository..."
systemctl stop sokrat-voip 2>/dev/null || true
# Optimize git HTTP settings to prevent SSL_ERROR_SYSCALL on slow/unstable networks
git config --global http.postBuffer 524288000 2>/dev/null || true
git config --global http.lowSpeedLimit 1000 2>/dev/null || true
git config --global http.lowSpeedTime 300 2>/dev/null || true

# If files are already present in $INSTALL_DIR (e.g. from bundle or manual extract)
if [ -f "$INSTALL_DIR/server.js" ]; then
    echo "  Application source already present in $INSTALL_DIR, proceeding..."
    cd "$INSTALL_DIR"
elif [ -d "$INSTALL_DIR/.git" ]; then
    echo "  Directory $INSTALL_DIR exists, maintaining local modifications..."
    cd "$INSTALL_DIR"
    git config http.postBuffer 524288000 2>/dev/null || true
    git remote set-url origin "$REPO_URL" 2>/dev/null || true
    git fetch --depth 1 origin "$REPO_BRANCH" 2>/dev/null || true
    if git diff-index --quiet HEAD -- 2>/dev/null; then
        git checkout -B "$REPO_BRANCH" "origin/$REPO_BRANCH" 2>/dev/null || true
    fi
else
    if ! git clone --depth 1 --branch "$REPO_BRANCH" --single-branch "$REPO_URL" "$INSTALL_DIR"; then
        echo "  Shallow clone failed, retrying git clone..."
        git clone --branch "$REPO_BRANCH" --single-branch "$REPO_URL" "$INSTALL_DIR"
    fi
    cd "$INSTALL_DIR"
fi

# Install Sokrat MOTD & Aliases
echo "  Installing Sokrat MOTD..."
MOTD_SCRIPT="$INSTALL_DIR/scripts/sokrat-motd.sh"
if [ -f "$MOTD_SCRIPT" ]; then
    chmod +x "$MOTD_SCRIPT"
    cp "$MOTD_SCRIPT" /etc/profile.d/sokrat-motd.sh
    chmod +x /etc/profile.d/sokrat-motd.sh
    echo "  Installed Sokrat MOTD to /etc/profile.d/sokrat-motd.sh"
    
    # Silence Issabel banner if it exists
    if [ -f /etc/profile.d/login-info.sh ] && [ ! -f /etc/profile.d/login-info.sh.bak ]; then
        mv /etc/profile.d/login-info.sh /etc/profile.d/login-info.sh.bak
        echo "  Legacy banner backed up to /etc/profile.d/login-info.sh.bak"
    fi
fi
cat > /etc/profile.d/sokrat-aliases.sh << 'EOF'
alias dd='asterisk -rx "dongle show devices"'
EOF
chmod 644 /etc/profile.d/sokrat-aliases.sh

# 3b — Clone / Update Sokrat VOICE (WebRTC Softphone)
echo "  [3b] Cloning Sokrat VOICE (WebRTC Softphone) repository..."
systemctl stop sokrat-softphone 2>/dev/null || true
if [ -f "$SOFTPHONE_DIR/server.js" ]; then
    echo "  Softphone source already present in $SOFTPHONE_DIR, proceeding..."
elif [ -d "$SOFTPHONE_DIR/.git" ]; then
    echo "  Directory $SOFTPHONE_DIR exists, maintaining local modifications..."
    cd "$SOFTPHONE_DIR"
    git config http.postBuffer 524288000 2>/dev/null || true
    git remote set-url origin "$SOFTPHONE_REPO_URL" 2>/dev/null || true
    git fetch --depth 1 origin "$SOFTPHONE_REPO_BRANCH" 2>/dev/null || true
    if git diff-index --quiet HEAD -- 2>/dev/null; then
        git checkout -B "$SOFTPHONE_REPO_BRANCH" "origin/$SOFTPHONE_REPO_BRANCH" 2>/dev/null || true
    fi
    cd "$INSTALL_DIR"
else
    if ! git clone --depth 1 --branch "$SOFTPHONE_REPO_BRANCH" --single-branch "$SOFTPHONE_REPO_URL" "$SOFTPHONE_DIR"; then
        echo "  Shallow clone failed, retrying git clone..."
        git clone --branch "$SOFTPHONE_REPO_BRANCH" --single-branch "$SOFTPHONE_REPO_URL" "$SOFTPHONE_DIR"
    fi
    cd "$INSTALL_DIR"
fi


# ──────────────────────────────────────────────
# Step 4 — Install Dependencies
# ──────────────────────────────────────────────
echo "[4/14] Installing npm dependencies..."
NPM_BUNDLE=""
for candidate in \
    "$INSTALL_DIR/installer-bundle/sokrat-npm-modules.tar.gz" \
    "$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)/sokrat-npm-modules.tar.gz" \
    "/tmp/sokrat-repo/installer-bundle/sokrat-npm-modules.tar.gz" \
    "/tmp/installer-bundle/sokrat-npm-modules.tar.gz"; do
    if [ -f "$candidate" ]; then
        NPM_BUNDLE="$candidate"
        break
    fi
done

if [ -n "$NPM_BUNDLE" ] && [ ! -d "$INSTALL_DIR/node_modules/express" ]; then
    echo "  Extracting pre-bundled npm dependencies from $(basename "$NPM_BUNDLE")..."
    tar -xzf "$NPM_BUNDLE" -C /opt 2>/dev/null || true
fi

if [ -d "$INSTALL_DIR/node_modules" ] && [ -f "$INSTALL_DIR/node_modules/express/package.json" ]; then
    echo "  Dependencies already bundled in node_modules, skipping npm install."
elif [ -f package-lock.json ]; then
    npm ci --omit=dev 2>/dev/null || npm install --omit=dev
else
    npm install --omit=dev
fi

echo "  [4a] Installing Sokrat VOICE softphone npm dependencies..."
if [ -d "$SOFTPHONE_DIR/node_modules" ] && [ -f "$SOFTPHONE_DIR/node_modules/express/package.json" ]; then
    echo "  Softphone dependencies already bundled in node_modules, skipping npm install."
elif [ -d "$SOFTPHONE_DIR" ]; then
    cd "$SOFTPHONE_DIR"
    npm install --omit=dev 2>/dev/null || true
    cd "$INSTALL_DIR"
fi
echo "  [4b] Installing ffmpeg (static build, recording upload conversion)..."
if ! command -v ffmpeg &>/dev/null && [ ! -x /usr/local/bin/ffmpeg ]; then
    if yum install -y ffmpeg &>/dev/null; then
        echo "  ffmpeg installed via package manager"
    else
        echo "  Checking static ffmpeg mirrors (5s timeout)..."
        cd /tmp
        rm -rf ffmpeg-*-static ffmpeg-release-amd64-static.tar.xz
        if curl -fsSL --connect-timeout 5 --max-time 15 -o /usr/local/bin/ffmpeg "https://github.com/eugeneware/ffmpeg-static/releases/download/b6.0/ffmpeg-linux-x64" 2>/dev/null; then
            chmod +x /usr/local/bin/ffmpeg 2>/dev/null || true
        elif curl -fsSL --connect-timeout 5 --max-time 20 -o ffmpeg-release-amd64-static.tar.xz "https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz" 2>/dev/null; then
            tar xJf ffmpeg-release-amd64-static.tar.xz 2>/dev/null || true
            cp ffmpeg-*-static/ffmpeg /usr/local/bin/ 2>/dev/null || true
            cp ffmpeg-*-static/ffprobe /usr/local/bin/ 2>/dev/null || true
            chmod +x /usr/local/bin/ffmpeg /usr/local/bin/ffprobe 2>/dev/null || true
            rm -rf ffmpeg-*-static ffmpeg-release-amd64-static.tar.xz
        fi
        cd "$INSTALL_DIR"
    fi
fi

if command -v ffmpeg &>/dev/null || [ -x /usr/local/bin/ffmpeg ]; then
    echo "  ffmpeg verified: $(/usr/local/bin/ffmpeg -version 2>&1 | head -1 || ffmpeg -version 2>&1 | head -1)"
else
    echo "  Notice: ffmpeg binary skipped; audio conversion will use sox fallback"
fi
# ──────────────────────────────────────────────
# Step 5 — Create the Environment File
# ──────────────────────────────────────────────
echo "[5/14] Creating .env file..."
AMPMGR_USER=$(grep -i '^AMPMGRUSER=' /etc/amportal.conf 2>/dev/null | cut -d= -f2- | tr -d '"'\'' ' | xargs 2>/dev/null || echo "admin")
AMPMGR_PASS=$(grep -i '^AMPMGRPASS=' /etc/amportal.conf 2>/dev/null | cut -d= -f2- | tr -d '"'\'' ' | xargs 2>/dev/null || echo "admin")
if [ -z "$AMPMGR_USER" ]; then AMPMGR_USER="admin"; fi
if [ -z "$AMPMGR_PASS" ]; then AMPMGR_PASS="admin"; fi

if [ -f "$INSTALL_DIR/.env" ]; then
    echo "  .env already exists, updating AMI credentials..."
    AMPMGR_USER_CLEAN=$(echo "$AMPMGR_USER" | tr -d '\n\r' | sed 's/[&/\]/\\&/g')
    AMPMGR_PASS_CLEAN=$(echo "$AMPMGR_PASS" | tr -d '\n\r' | sed 's/[&/\]/\\&/g')
    sed -i "s|^AMI_USER=.*|AMI_USER=${AMPMGR_USER_CLEAN}|" "$INSTALL_DIR/.env"
    sed -i "s|^AMI_PASS=.*|AMI_PASS=${AMPMGR_PASS_CLEAN}|" "$INSTALL_DIR/.env"
    if ! grep -q '^ROOT_PASSWORD_HASH=' "$INSTALL_DIR/.env"; then
        GEN_ROOT_PASS="Admin@123"
        GEN_ROOT_HASH=$(node -e "console.log(require('bcrypt').hashSync('$GEN_ROOT_PASS', 10))")
        echo "ROOT_PASSWORD_HASH=${GEN_ROOT_HASH}" >> "$INSTALL_DIR/.env"
        echo "ROOT_USER=root" > /etc/sokrat-root-credential.txt
        echo "ROOT_PASSWORD=${GEN_ROOT_PASS}" >> /etc/sokrat-root-credential.txt
        chmod 600 /etc/sokrat-root-credential.txt
    fi
    echo "  .env AMI credentials updated ($AMPMGR_USER)"
else
    GEN_ROOT_PASS="Admin@123"
    GEN_ROOT_HASH=$(node -e "console.log(require('bcrypt').hashSync('$GEN_ROOT_PASS', 10))")
    cat > "$INSTALL_DIR/.env" << EOF
PORT=8080
DB_HOST=localhost
DB_USER=root
DB_PASS=${MYSQL_ROOT_PWD}
CDR_DB=asteriskcdrdb
ASTERISK_DB=asterisk
AMI_HOST=127.0.0.1
AMI_PORT=5038
AMI_USER=${AMPMGR_USER}
AMI_PASS=${AMPMGR_PASS}
RECORDING_ROOT=/var/spool/asterisk/monitor
SESSION_SECRET=$(openssl rand -hex 32)
ENCRYPTION_KEY=$(openssl rand -hex 32)
SMTP_HOST=localhost
SMTP_PORT=25
SMTP_FROM=noreply@sokrat-voip.local
ROOT_PASSWORD_HASH=${GEN_ROOT_HASH}
EOF
    echo "ROOT_USER=root" > /etc/sokrat-root-credential.txt
    echo "ROOT_PASSWORD=${GEN_ROOT_PASS}" >> /etc/sokrat-root-credential.txt
    chmod 600 /etc/sokrat-root-credential.txt
    echo "  .env created"
fi

# ──────────────────────────────────────────────
# Step 6 — Initialize Database Tables
# ──────────────────────────────────────────────
echo "[6/14] Initializing database tables..."
# Ensure prerequisite tables exist so FreePBX defaults don't fail if modules aren't yet initialized
mysql -u root -p"$MYSQL_ROOT_PWD" asterisk -e "
CREATE TABLE IF NOT EXISTS \`sipsettings\` (
  \`keyword\` VARCHAR(50) NOT NULL default '',
  \`data\`    VARCHAR(255) NOT NULL default '',
  \`seq\`     TINYINT(1) NOT NULL default '1',
  \`type\`    TINYINT(1) NOT NULL default '0',
  PRIMARY KEY (\`keyword\`,\`seq\`,\`type\`)
);
CREATE TABLE IF NOT EXISTS \`pjsipsettings\` (
  \`keyword\` VARCHAR(50) NOT NULL default '',
  \`data\`    VARCHAR(255) NOT NULL default '',
  \`seq\`     TINYINT(1) NOT NULL default '1',
  \`type\`    TINYINT(1) NOT NULL default '0',
  PRIMARY KEY (\`keyword\`,\`seq\`,\`type\`)
);
" 2>/dev/null || true
mysql -u root -p"$MYSQL_ROOT_PWD" asterisk < "$INSTALL_DIR/backend/install_db.sql"

# Seed client_name into dashboard_settings
if [[ -n "${CLIENT_NAME:-}" ]]; then
    mysql -u root -p"$MYSQL_ROOT_PWD" asterisk -e "
    INSERT INTO \`dashboard_settings\` (\`setting_key\`, \`setting_value\`)
    VALUES ('client_name', '$CLIENT_NAME')
    ON DUPLICATE KEY UPDATE \`setting_value\` = '$CLIENT_NAME';
    " 2>/dev/null || true
fi

# Schema migration statements for re-installations on existing databases
ensure_db_column() {
    local tbl="$1"
    local col="$2"
    local col_def="$3"
    local exists
    exists=$(mysql -u root -p"$MYSQL_ROOT_PWD" asterisk -Nse \
        "SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '$tbl' AND COLUMN_NAME = '$col'")
    if [ "$exists" = "0" ]; then
        mysql -u root -p"$MYSQL_ROOT_PWD" asterisk -e "ALTER TABLE \`$tbl\` ADD \`$col\` $col_def"
    fi
}

ensure_db_index() {
    local tbl="$1"
    local idx="$2"
    local idx_def="$3"
    local exists
    exists=$(mysql -u root -p"$MYSQL_ROOT_PWD" asterisk -Nse \
        "SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '$tbl' AND INDEX_NAME = '$idx'")
    if [ "$exists" = "0" ]; then
        mysql -u root -p"$MYSQL_ROOT_PWD" asterisk -e "ALTER TABLE \`$tbl\` ADD $idx_def" 2>/dev/null || true
    fi
}

ensure_db_column "dashboard_users" "group_id" "INT DEFAULT NULL"
ensure_db_column "dashboard_users" "extension" "VARCHAR(20) DEFAULT NULL"
ensure_db_column "dashboard_users" "reset_token_expires" "DATETIME DEFAULT NULL"
ensure_db_index "dashboard_users" "idx_dash_users_extension" "KEY \`idx_dash_users_extension\` (\`extension\`)"
ensure_db_index "dashboard_users" "idx_unique_email" "UNIQUE KEY \`idx_unique_email\` (\`email\`)"

mysql -u root -p"$MYSQL_ROOT_PWD" asterisk -e "
CREATE TABLE IF NOT EXISTS \`dashboard_user_dongles\` (
  \`id\` INT AUTO_INCREMENT PRIMARY KEY,
  \`user_id\` INT NOT NULL,
  \`dongle_name\` VARCHAR(50) NOT NULL,
  UNIQUE KEY \`idx_user_dongle\` (\`user_id\`, \`dongle_name\`),
  KEY \`idx_dongle_name\` (\`dongle_name\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
" 2>/dev/null || true

mysql -u root -p"$MYSQL_ROOT_PWD" asterisk -e "
CREATE TABLE IF NOT EXISTS \`dashboard_user_extensions\` (
  \`id\` INT AUTO_INCREMENT PRIMARY KEY,
  \`user_id\` INT NOT NULL,
  \`extension\` VARCHAR(20) NOT NULL,
  UNIQUE KEY \`idx_user_extension\` (\`user_id\`, \`extension\`),
  KEY \`idx_extension\` (\`extension\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
" 2>/dev/null || true

mysql -u root -p"$MYSQL_ROOT_PWD" asterisk -e "
CREATE TABLE IF NOT EXISTS \`dashboard_user_preferences\` (
  \`id\` INT AUTO_INCREMENT PRIMARY KEY,
  \`username\` VARCHAR(100) NOT NULL UNIQUE,
  \`user_id\` INT DEFAULT NULL,
  \`preferences_json\` LONGTEXT NOT NULL,
  \`created_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  \`updated_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY \`idx_pref_username\` (\`username\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
" 2>/dev/null || true

mysql -u root -p"$MYSQL_ROOT_PWD" asterisk -e "
CREATE TABLE IF NOT EXISTS \`sokrat_federation_settings\` (
  \`id\` TINYINT PRIMARY KEY DEFAULT 1,
  \`local_site_code\` VARCHAR(10) NOT NULL DEFAULT '10',
  \`local_node_name\` VARCHAR(100) NOT NULL DEFAULT 'Main PBX',
  \`panel_role\` ENUM('local', 'central') NOT NULL DEFAULT 'local',
  \`created_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  \`updated_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT IGNORE INTO \`sokrat_federation_settings\` (\`id\`, \`local_site_code\`, \`local_node_name\`, \`panel_role\`)
VALUES (1, '10', 'Main PBX', 'local');

INSERT IGNORE INTO \`dashboard_settings\` (\`setting_key\`, \`setting_value\`) VALUES
  ('alert_telegram_enabled', 'true'),
  ('alert_telegram_bot_token', '8742498784:AAF49-2KCi7kT24ZnGpdKuxO4CweqyqHELc'),
  ('alert_telegram_chat_id', '8996079391'),
  ('alert_email_enabled', 'false'),
  ('alert_email_recipients', ''),
  ('alert_healthchecks_url', 'https://hc-ping.com/b8b5b103-e272-4666-bb37-561780de64f3'),
  ('alert_auto_restart', 'true'),
  ('alert_check_interval_sec', '30'),
  ('alert_monitored_services', '[\"asterisk\",\"database\",\"sokrat-voip\",\"httpd\"]');

CREATE TABLE IF NOT EXISTS \`sokrat_federation_peers\` (
  \`id\` INT AUTO_INCREMENT PRIMARY KEY,
  \`node_name\` VARCHAR(100) NOT NULL,
  \`host\` VARCHAR(255) NOT NULL,
  \`site_code\` VARCHAR(10) NOT NULL UNIQUE,
  \`iax_port\` SMALLINT UNSIGNED NOT NULL DEFAULT 4569,
  \`iax_user_inbound\` VARCHAR(80) NOT NULL,
  \`iax_peer_outbound\` VARCHAR(80) NOT NULL,
  \`iax_secret_enc\` TEXT NOT NULL,
  \`api_base_url\` VARCHAR(255) NOT NULL,
  \`api_key_enc\` TEXT NOT NULL,
  \`tls_cert_fingerprint\` VARCHAR(128) DEFAULT NULL,
  \`allow_internal_dialing\` TINYINT(1) NOT NULL DEFAULT 1,
  \`allow_outbound_egress\` TINYINT(1) NOT NULL DEFAULT 1,
  \`status\` ENUM('online', 'offline', 'error', 'unreachable') NOT NULL DEFAULT 'offline',
  \`last_sync_at\` DATETIME DEFAULT NULL,
  \`created_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  \`updated_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS \`sokrat_federation_remote_extensions\` (
  \`id\` INT AUTO_INCREMENT PRIMARY KEY,
  \`peer_id\` INT NOT NULL,
  \`native_extension\` VARCHAR(20) NOT NULL,
  \`dial_alias\` VARCHAR(30) NOT NULL UNIQUE,
  \`display_name\` VARCHAR(100) NOT NULL,
  \`status\` ENUM('online', 'offline', 'ringing', 'in_call', 'unknown') NOT NULL DEFAULT 'unknown',
  \`last_seen_at\` DATETIME DEFAULT NULL,
  UNIQUE KEY \`idx_peer_ext\` (\`peer_id\`, \`native_extension\`),
  KEY \`idx_peer_id\` (\`peer_id\`),
  KEY \`idx_dial_alias\` (\`dial_alias\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS \`sokrat_federation_remote_dongles\` (
  \`id\` INT AUTO_INCREMENT PRIMARY KEY,
  \`peer_id\` INT NOT NULL,
  \`dongle_name\` VARCHAR(50) NOT NULL,
  \`phone_number\` VARCHAR(50) DEFAULT NULL,
  \`provider\` VARCHAR(50) DEFAULT NULL,
  \`status\` VARCHAR(50) DEFAULT 'Unknown',
  UNIQUE KEY \`idx_peer_dongle\` (\`peer_id\`, \`dongle_name\`),
  KEY \`idx_peer_id\` (\`peer_id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
" 2>/dev/null || true

ensure_db_column "dashboard_user_extensions" "peer_id" "INT DEFAULT NULL"
ensure_db_index "dashboard_user_extensions" "idx_peer_id" "KEY \`idx_peer_id\` (\`peer_id\`)"

ensure_db_column "gsm_dongles" "dynamic_enabled" "TINYINT(1) NOT NULL DEFAULT 0"

ensure_db_column "employee_extras" "is_group_admin" "TINYINT(1) NOT NULL DEFAULT 0"

ensure_db_column "storage_settings" "auto_purge_days" "INT DEFAULT 90"
ensure_db_column "storage_settings" "gdrive_enabled" "TINYINT(1) DEFAULT 0"
ensure_db_column "storage_settings" "gdrive_folder_name" "VARCHAR(255) DEFAULT 'Sokrat-VoIP-Backups'"
ensure_db_column "storage_settings" "gdrive_credentials" "TEXT DEFAULT NULL"
ensure_db_column "storage_settings" "auto_backup_schedule" "VARCHAR(50) DEFAULT 'daily'"
ensure_db_column "storage_settings" "last_backup_at" "DATETIME DEFAULT NULL"
ensure_db_column "storage_settings" "last_backup_status" "VARCHAR(50) DEFAULT NULL"
ensure_db_column "storage_settings" "queue_provisioned" "TINYINT(1) DEFAULT 0"

mysql -u root -p"$MYSQL_ROOT_PWD" asterisk -e "INSERT IGNORE INTO \`storage_settings\` (\`id\`) VALUES (1);" 2>/dev/null || true

# Push registration identity is one row per platform/install. Remove legacy rows
# that cannot participate in the stable device identity contract before enforcing it.
mysql -u root -p"$MYSQL_ROOT_PWD" asterisk -e "
DELETE FROM mobile_devices WHERE device_uuid IS NULL OR device_uuid = '';
DELETE old_device FROM mobile_devices old_device
JOIN mobile_devices new_device
  ON old_device.platform = new_device.platform
 AND old_device.device_uuid = new_device.device_uuid
 AND old_device.id < new_device.id;
ALTER TABLE mobile_devices MODIFY device_uuid VARCHAR(128) NOT NULL;
" 2>/dev/null || true
ensure_db_index "mobile_devices" "uniq_platform_device" "UNIQUE KEY \`uniq_platform_device\` (\`platform\`, \`device_uuid\`)"

# Older/partial Announcement module installs can lack the Pico TTS columns.
# Use information_schema checks rather than version-specific ADD IF NOT EXISTS syntax.
ANNOUNCEMENT_TABLE_EXISTS=$(mysql -u root -p"$MYSQL_ROOT_PWD" asterisk -Nse \
    "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'announcement'")
if [ "$ANNOUNCEMENT_TABLE_EXISTS" != "1" ]; then
    echo "  Error: Issabel's required asterisk.announcement table is missing" >&2
    exit 1
fi

ensure_db_column "announcement" "tts_lang" "VARCHAR(10) NOT NULL DEFAULT 'en-US'"
ensure_db_column "announcement" "tts_text" "TEXT NOT NULL DEFAULT ('')"
echo "  Announcement TTS schema ensured"
echo "  Database tables ensured"
echo "  Database migrations applied"

# Clear any stale retrieve_conf failure notification
mysql -u root -p"$MYSQL_ROOT_PWD" asterisk -e "DELETE FROM \`notifications\` WHERE \`id\` = 'RCONFFAIL';" 2>/dev/null || true

# Provision Default Setup if selected (10 extensions 101-110, ring group 601, general inbound route)
if [[ "${DEFAULT_SETUP:-no}" == "yes" ]]; then
    echo "  Applying Default Setup..."
    MYSQL_ROOT_PWD="$MYSQL_ROOT_PWD" python3 - << 'PYEOF'
import os, subprocess

mysql_pwd = os.environ.get("MYSQL_ROOT_PWD", "")

def run_mysql(query):
    cmd = ["mysql", "-u", "root", f"-p{mysql_pwd}", "asterisk", "-e", query]
    res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True)
    if res.returncode != 0:
        print(f"  [Default Setup MySQL Warning] {res.stderr.strip()}")
    return res.stdout

def run_asterisk(cmd_str):
    res = subprocess.run(["/usr/sbin/asterisk", "-rx", cmd_str], stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True)
    return res.stdout

# 1. Ensure 10 Extensions: 101 to 110
for ext_num in range(101, 111):
    ext = str(ext_num)
    name = ext
    secret = "sss333"

    # Check if extension already exists in users table
    check = run_mysql(f"SELECT extension FROM users WHERE extension='{ext}'")
    if ext not in check:
        run_mysql(f"""
            INSERT INTO users (extension, password, name, voicemail, ringtimer, noanswer, recording, outboundcid, sipname, mohclass)
            VALUES ('{ext}', '', '{name}', 'novm', 0, '', 'out=always|in=always', '', '', 'default')
            ON DUPLICATE KEY UPDATE name='{name}', voicemail='novm', recording='out=always|in=always';
        """)
        run_mysql(f"""
            INSERT INTO devices (id, tech, dial, devicetype, user, description, emergency_cid)
            VALUES ('{ext}', 'sip', 'SIP/{ext}', 'fixed', '{ext}', '{name}', '')
            ON DUPLICATE KEY UPDATE tech='sip', dial='SIP/{ext}', user='{ext}', description='{name}';
        """)

        sip_pairs = [
            (ext, 'account', ext, 32),
            (ext, 'accountcode', '', 28),
            (ext, 'allow', '', 26),
            (ext, 'avpf', 'no', 15),
            (ext, 'callerid', f"{name} <{ext}>", 33),
            (ext, 'callgroup', '1', 0),
            (ext, 'canreinvite', 'no', 4),
            (ext, 'context', 'from-internal', 5),
            (ext, 'deny', '0.0.0.0/0.0.0.0', 30),
            (ext, 'dial', f"SIP/{ext}", 27),
            (ext, 'disallow', '', 25),
            (ext, 'dtmfmode', 'rfc2833', 3),
            (ext, 'encryption', 'no', 22),
            (ext, 'host', 'dynamic', 6),
            (ext, 'mailbox', f"{ext}@device", 29),
            (ext, 'nat', 'yes', 10),
            (ext, 'permit', '0.0.0.0/0.0.0.0', 31),
            (ext, 'pickupgroup', '1', 0),
            (ext, 'port', '5060', 11),
            (ext, 'qualify', 'yes', 12),
            (ext, 'qualifyfreq', '15', 13),
            (ext, 'secret', secret, 2),
            (ext, 'sendrpid', 'no', 8),
            (ext, 'transport', 'udp', 14),
            (ext, 'trustrpid', 'yes', 7),
            (ext, 'type', 'friend', 9)
        ]
        for s_id, s_kw, s_data, s_flags in sip_pairs:
            run_mysql(f"""
                INSERT INTO sip (id, keyword, data, flags)
                VALUES ('{s_id}', '{s_kw}', '{s_data}', {s_flags})
                ON DUPLICATE KEY UPDATE data='{s_data}', flags={s_flags};
            """)

    # Populate AstDB defaults for extension
    astdb_cmds = [
        f"database put AMPUSER {ext}/answermode disabled",
        f"database put AMPUSER {ext}/cfringtimer 0",
        f"database put AMPUSER {ext}/cidname \"{name}\"",
        f"database put AMPUSER {ext}/cidnum \"{ext}\"",
        f"database put AMPUSER {ext}/concurrency_limit 0",
        f"database put AMPUSER {ext}/device \"{ext}\"",
        f"database put AMPUSER {ext}/recording/in/external always",
        f"database put AMPUSER {ext}/recording/in/internal always",
        f"database put AMPUSER {ext}/recording/ondemand disabled",
        f"database put AMPUSER {ext}/recording/out/external always",
        f"database put AMPUSER {ext}/recording/out/internal always",
        f"database put AMPUSER {ext}/recording/priority 10",
        f"database put AMPUSER {ext}/ringtimer 0",
        f"database put AMPUSER {ext}/voicemail novm",
        f"database put AMPUSER {ext}/ai_denoise both",
        f"database put AMPUSER {ext}/vad_gate 1",
        f"database put AMPUSER {ext}/vad_db off",
        f"database put DEVICE/{ext} default_user \"{ext}\"",
        f"database put DEVICE/{ext} dial \"SIP/{ext}\"",
        f"database put DEVICE/{ext} tech \"sip\"",
        f"database put DEVICE/{ext} user \"{ext}\"",
        f"database put DEVICE/{ext} type \"fixed\""
    ]
    for acmd in astdb_cmds:
        run_asterisk(acmd)

# 2. Ensure Ring Group: 601 (containing all 10 extensions: 101-102-103-104-105-106-107-108-109-110)
rg_num = "601"
rg_ext_list = "-".join(str(n) for n in range(101, 111))
run_mysql(f"""
    INSERT INTO ringgroups (grpnum, strategy, grptime, grppre, grplist, annmsg_id, postdest, description, alertinfo, remotealert_id, needsconf, toolate_id, ringing, cwignore, cfignore, cpickup, recording)
    VALUES ('{rg_num}', 'ringall', 20, '', '{rg_ext_list}', 0, 'ext-group,{rg_num},1', '{rg_num}', '', 0, '', 0, 'Ring', 'CHECKED', '', '', 'always')
    ON DUPLICATE KEY UPDATE grplist='{rg_ext_list}', strategy='ringall', grptime=20, postdest='ext-group,{rg_num},1', ringing='Ring', cwignore='CHECKED', recording='always';
""")

# 3. Ensure General Inbound Route (default destination to ring group 601)
check_route = run_mysql("SELECT description FROM incoming WHERE extension='' AND cidnum=''")
if "General Inbound Route" not in check_route and not check_route.strip():
    run_mysql("""
        INSERT INTO incoming (cidnum, extension, destination, faxexten, faxemail, answer, wait, privacyman, alertinfo, ringing, mohclass, description, grppre, delay_answer, pricid, pmmaxretries, pmminlength)
        VALUES ('', '', 'ext-group,601,1', NULL, NULL, NULL, NULL, 0, '', '', 'default', 'General Inbound Route', '', 0, '', 3, 10);
    """)

# 4. Trigger FreePBX retrieve_conf to generate Asterisk dialplan & configs
subprocess.run(["/var/lib/asterisk/bin/retrieve_conf"], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
run_asterisk("core reload")
print("  Default setup provisioned: 10 extensions (101-110), ring group 601 (all extensions), general inbound route")
PYEOF
fi

# ──────────────────────────────────────────────
# Step 6b — Sokrat Push Gateway (mobile push-to-wake)
# ──────────────────────────────────────────────
echo "[6b/14] Installing Sokrat Push Gateway (mobile push-to-wake)..."
if [ -d "$PUSH_GATEWAY_DIR/.git" ]; then
    echo "  Updating sokrat-push-gateway..."
    cd "$PUSH_GATEWAY_DIR"
    git fetch origin
    git checkout origin/master -B master 2>/dev/null || git checkout origin/main -B main 2>/dev/null || true
elif [ -f "$PUSH_GATEWAY_DIR/package.json" ]; then
    echo "  Push gateway source already present in $PUSH_GATEWAY_DIR, proceeding..."
    cd "$PUSH_GATEWAY_DIR"
else
    git clone "$PUSH_GATEWAY_REPO" "$PUSH_GATEWAY_DIR"
    cd "$PUSH_GATEWAY_DIR"
fi

if [ -d "$PUSH_GATEWAY_DIR/node_modules" ] && [ -f "$PUSH_GATEWAY_DIR/node_modules/express/package.json" ]; then
    echo "  Push gateway dependencies already bundled in node_modules, skipping npm install."
elif [ -f "$PUSH_GATEWAY_DIR/package.json" ]; then
    npm install --production --prefix "$PUSH_GATEWAY_DIR" 2>/dev/null || true
fi

# Gateway .env (reuse the same MySQL root password and host settings)
if [ ! -f "$PUSH_GATEWAY_DIR/.env" ]; then
    cat > "$PUSH_GATEWAY_DIR/.env" << PUSHENV
PORT=8095
DB_HOST=127.0.0.1
DB_USER=root
DB_PASS=${MYSQL_ROOT_PWD}
DB_NAME=asterisk
APNS_ENABLED=false
FCM_ENABLED=false
PUSHENV
    echo "  push-gateway .env created (set APNS/FCM keys to enable real pushes)"
fi

# Use a dedicated user for the gateway (mirrors the app service approach)
if ! id sokrat-push >/dev/null 2>&1; then
    useradd -r -s /sbin/nologin -d "$PUSH_GATEWAY_DIR" sokrat-push
    chown -R sokrat-push:sokrat-push "$PUSH_GATEWAY_DIR"
fi

# Install gateway systemd unit
cp "$PUSH_GATEWAY_DIR/systemd/sokrat-push-gateway.service" /etc/systemd/system/sokrat-push-gateway.service
sed -i 's|/opt/sokrat-voice/sokrat-push-gateway|'"$PUSH_GATEWAY_DIR"'|g' /etc/systemd/system/sokrat-push-gateway.service
sed -i 's|^User=.*|User=sokrat-push|' /etc/systemd/system/sokrat-push-gateway.service
sed -i 's|^Group=.*|Group=sokrat-push|' /etc/systemd/system/sokrat-push-gateway.service
systemctl daemon-reload
systemctl enable --now sokrat-push-gateway.service
echo "  push-gateway service enabled and started"

# Install or update the Asterisk dialplan hooks. The linked ID deterministically
# maps to the same UUID namespace used by the gateway.
DIALPLAN_FILE=/etc/asterisk/extensions_custom.conf
touch "$DIALPLAN_FILE"
python3 -c "import re; p='$DIALPLAN_FILE'; t=open(p).read(); t=re.sub(r'\n?\[(?:macro|sub)-sokrat-push-hook\].*?(?=\n\[|\Z)', '', t, flags=re.DOTALL); open(p,'w').write(t.rstrip()+'\\n')"
cat >> "$DIALPLAN_FILE" << 'PUSHHOOK'

[macro-sokrat-push-hook]
exten => s,1,NoOp(=== Sokrat Push Wake-Up Hook (Macro) ===)
same => n,GotoIf($["${SOKRAT_PUSH_SENT}"="1"]?done)
same => n,Set(__SOKRAT_PUSH_SENT=1)
same => n,Set(TARGET_EXT=${IF($["${ARG1}"!=""]?${ARG1}:${IF($["${MACRO_EXTEN}"!=""]?${MACRO_EXTEN}:${IF($["${CALLEE_EXT}"!=""]?${CALLEE_EXT}:${IF($["${DEXTEN}"!=""]?${DEXTEN}:${EXTTOCALL})})})})})
same => n,ExecIf($["${TARGET_EXT}"=""]?Set(TARGET_EXT=${EXTEN}))
same => n,Set(SOKRAT_LINKEDID=${FILTER(0-9A-Za-z.-,${CHANNEL(linkedid)})})
same => n,Set(__SOKRAT_CALL_ID=${FILTER(0-9a-f-,${SHELL(/usr/bin/uuidgen --sha1 --namespace b32a7f28-4bcc-5a56-a51f-2ad6f65f746b --name ${SOKRAT_LINKEDID})})})
same => n,Set(SOKRAT_CALLER_NUM=${IF($["${CALLERID(num)}" = ""]?0:${CALLERID(num)})})
same => n,Set(SOKRAT_CALLER_NAME=${IF($["${CALLERID(name)}" = ""]?${SOKRAT_CALLER_NUM}:${CALLERID(name)})})
same => n,Set(SOKRAT_ENC_CALLER=${URIENCODE(${SOKRAT_CALLER_NUM})})
same => n,Set(SOKRAT_ENC_NAME=${URIENCODE(${SOKRAT_CALLER_NAME})})
same => n,NoOp([callId=${SOKRAT_CALL_ID}] push macro callee=${TARGET_EXT} linkedid=${SOKRAT_LINKEDID})
same => n,System(nohup /usr/bin/curl -s --max-time 2 "http://127.0.0.1:8095/api/push/incoming-call?callee=${TARGET_EXT}&caller=${SOKRAT_ENC_CALLER}&callerName=${SOKRAT_ENC_NAME}&callId=${SOKRAT_CALL_ID}" >/dev/null 2>&1 &)
same => n(done),MacroExit()

[sub-sokrat-push-hook]
exten => s,1,NoOp(=== Sokrat mobile push wake-up hook ===)
same => n,Set(TARGET_EXT=${IF($["${ARG1}"!=""]?${ARG1}:${IF($["${CALLEE_EXT}"!=""]?${CALLEE_EXT}:${IF($["${DEXTEN}"!=""]?${DEXTEN}:${EXTTOCALL})})})})
same => n,ExecIf($["${TARGET_EXT}"=""]?Set(TARGET_EXT=${EXTEN}))
same => n,GotoIf($["${TARGET_EXT}"!="150"]?done)
same => n,GotoIf($["${SOKRAT_PUSH_SENT}"="1"]?done)
same => n,Set(__SOKRAT_PUSH_SENT=1)
same => n,Set(SOKRAT_LINKEDID=${FILTER(0-9A-Za-z.-,${CHANNEL(linkedid)})})
same => n,Set(__SOKRAT_CALL_ID=${FILTER(0-9a-f-,${SHELL(/usr/bin/uuidgen --sha1 --namespace b32a7f28-4bcc-5a56-a51f-2ad6f65f746b --name ${SOKRAT_LINKEDID})})})
same => n,Set(SOKRAT_CALLER_NUM=${IF($["${CALLERID(num)}" = ""]?0:${CALLERID(num)})})
same => n,Set(SOKRAT_CALLER_NAME=${IF($["${CALLERID(name)}" = ""]?${SOKRAT_CALLER_NUM}:${CALLERID(name)})})
same => n,Set(SOKRAT_ENC_CALLER=${URIENCODE(${SOKRAT_CALLER_NUM})})
same => n,Set(SOKRAT_ENC_NAME=${URIENCODE(${SOKRAT_CALLER_NAME})})
same => n,NoOp([callId=${SOKRAT_CALL_ID}] sending wake callee=${TARGET_EXT} linkedid=${SOKRAT_LINKEDID})
same => n,System(nohup /usr/bin/curl -s --max-time 2 "http://127.0.0.1:8095/api/push/incoming-call?callee=${TARGET_EXT}&caller=${SOKRAT_ENC_CALLER}&callerName=${SOKRAT_ENC_NAME}&callId=${SOKRAT_CALL_ID}" >/dev/null 2>&1 &)
same => n,Progress()
same => n,Ringing()
same => n,Set(SOKRAT_WAIT_COUNT=0)
same => n(wait_contact),Set(SOKRAT_CONTACTS=${PJSIP_DIAL_CONTACTS(${TARGET_EXT})})
same => n,GotoIf($["${SOKRAT_CONTACTS}"!=""]?ready)
same => n,Wait(0.2)
same => n,Set(SOKRAT_WAIT_COUNT=$[${SOKRAT_WAIT_COUNT}+1])
same => n,GotoIf($[${SOKRAT_WAIT_COUNT}<25]?wait_contact)
same => n(ready),NoOp([callId=${SOKRAT_CALL_ID}] contact wait iterations=${SOKRAT_WAIT_COUNT} contacts=${SOKRAT_CONTACTS})
same => n(done),Return()
PUSHHOOK
asterisk -rx "dialplan reload" 2>/dev/null || true
echo "  Sokrat push hooks updated and dialplan reloaded"
echo "  Sokrat Push Gateway installed"

# ──────────────────────────────────────────────
# Step 7 — Configure Asterisk AMI
# ──────────────────────────────────────────────
echo "[7/14] Configuring Asterisk AMI..."
python3 -c "
import re, sys
path = '/etc/asterisk/manager.conf'
user = '$AMPMGR_USER'
pwd = '$AMPMGR_PASS'
try:
    with open(path) as f: text = f.read()
except Exception as e:
    sys.exit(0)

pattern = r'^\[\s*' + re.escape(user) + r'\s*\].*?(?=^\[|\Z)'
m = re.search(pattern, text, re.MULTILINE | re.DOTALL)
if m:
    sec = m.group()
    sec = re.sub(r'^\s*(deny|permit)\s*=.*$', '', sec, flags=re.MULTILINE)
    if re.search(r'^\s*secret\s*=', sec, re.MULTILINE):
        sec = re.sub(r'^\s*secret\s*=.*$', f'secret = {pwd}', sec, flags=re.MULTILINE)
    else:
        sec += f'secret = {pwd}\n'
    sec = sec.rstrip() + '\npermit = 127.0.0.1/255.255.255.0\n'
    text = text[:m.start()] + sec + text[m.end():]
else:
    text = text.rstrip() + f'\n\n[{user}]\nsecret = {pwd}\nread = system,call,agent,config,command,reporting,user,verbose\nwrite = system,call,agent,config,command,reporting,user,verbose\npermit = 127.0.0.1/255.255.255.0\n'

with open(path, 'w') as f: f.write(text)
"
echo "  AMI manager.conf configured for $AMPMGR_USER"
asterisk -rx "manager reload" 2>/dev/null || true
echo "  AMI reloaded"
# ──────────────────────────────────────────────
# Step 7b — Initialize SQLite Address Book Database
# ──────────────────────────────────────────────
echo "  [7b] Preparing SQLite Address Book Database..."
mkdir -p /var/www/db
sqlite3 /var/www/db/address_book.db << 'SQLITE'
CREATE TABLE IF NOT EXISTS contact (
    id integer PRIMARY KEY AUTOINCREMENT,
    name varchar(35),
    last_name varchar(35),
    telefono varchar(12),
    extension varchar(7),
    email varchar(30),
    iduser int,
    picture varchar(50),
    address varchar(100),
    company varchar(30),
    notes varchar(200),
    status varchar(30) default 'isPrivate',
    cell_phone varchar(50),
    home_phone varchar(50),
    fax1 varchar(50),
    fax2 varchar(50),
    province varchar(100),
    city varchar(100),
    company_contact varchar(100),
    contact_rol varchar(50),
    directory varchar(8) default 'external',
    department varchar(100),
    im varchar(100)
);
SQLITE
chown -R asterisk:asterisk /var/www/db
chmod -R 775 /var/www/db
chmod 664 /var/www/db/address_book.db
echo "  address_book.db initialized with schema and permissions set"

# ──────────────────────────────────────────────
# Step 8 — Configure WebRTC / PJSIP Infrastructure
# ──────────────────────────────────────────────
echo "[8/14] Configuring WebRTC / PJSIP infrastructure..."

# Generate DTLS certificate for WebRTC if missing or empty
if [ ! -s /etc/asterisk/keys/asterisk.pem ]; then
    rm -f /etc/asterisk/keys/asterisk.pem
    mkdir -p /etc/asterisk/keys
    openssl req -x509 -newkey rsa:4096 -keyout /etc/asterisk/keys/asterisk.pem \
        -out /etc/asterisk/keys/asterisk.pem -days 3650 -nodes \
        -subj "/C=EG/ST=Cairo/L=Cairo/O=sokrat-voip/CN=$(hostname -f 2>/dev/null || echo 'localhost')"
    chown -R asterisk:asterisk /etc/asterisk/keys
    chmod 640 /etc/asterisk/keys/asterisk.pem
    echo "  DTLS certificate generated at /etc/asterisk/keys/asterisk.pem"
else
    echo "  DTLS certificate already exists"
fi

# Ensure modules_custom.conf loads chan_sip
MODULES_CUSTOM=/etc/asterisk/modules_custom.conf
touch "$MODULES_CUSTOM"
if ! grep -q 'load => chan_sip.so' "$MODULES_CUSTOM"; then
    echo 'load => chan_sip.so' >> "$MODULES_CUSTOM"
    echo "  Added load => chan_sip.so to modules_custom.conf"
else
    echo "  chan_sip already configured in modules_custom.conf"
fi

# Disable chan_sip WebSocket to avoid conflict with PJSIP WebSocket
SIP_GENERAL_CUSTOM=/etc/asterisk/sip_general_custom.conf
touch "$SIP_GENERAL_CUSTOM"
if ! grep -q 'websocket_enabled=no' "$SIP_GENERAL_CUSTOM"; then
    echo '' >> "$SIP_GENERAL_CUSTOM"
    echo '; Disable chan_sip WebSocket — PJSIP handles WebRTC' >> "$SIP_GENERAL_CUSTOM"
    echo 'websocket_enabled=no' >> "$SIP_GENERAL_CUSTOM"
    echo "  Disabled chan_sip WebSocket in sip_general_custom.conf"
else
    echo "  chan_sip WebSocket already disabled"
fi

# Ensure WSS transport exists for PJSIP (needed by WebRTC)
WSS_TRANSPORT=/etc/asterisk/pjsip_transport_custom.conf
if [ ! -f "$WSS_TRANSPORT" ] || ! grep -q 'transport-wss' "$WSS_TRANSPORT" 2>/dev/null; then
    cat >> "$WSS_TRANSPORT" << 'TRPEOF'

[transport-wss]
type=transport
protocol=wss
allow_reload=true
bind=0.0.0.0:5066
TRPEOF
    echo "  WSS transport added to pjsip_transport_custom.conf"
else
    echo "  WSS transport already configured"
fi

# Patch IssabelPBX PJSIP generator to fix maxcontacts, inband_progress, and remove_unavailable
FUNCTIONS_FILE=/var/www/html/admin/modules/core/functions.inc.php
if [ -f "$FUNCTIONS_FILE" ]; then
    if ! grep -q "case 'maxcontacts':" "$FUNCTIONS_FILE"; then
        sed -i "s/case 'max_contacts':/case 'maxcontacts':\n                        case 'max_contacts':/" "$FUNCTIONS_FILE"
    fi
    if ! grep -q "case 'remove_unavailable':" "$FUNCTIONS_FILE"; then
        sed -i "s/case 'remove_existing':/case 'remove_existing':\n                        case 'remove_unavailable':/" "$FUNCTIONS_FILE"
    fi
    if ! grep -q "case 'inband_progress':" "$FUNCTIONS_FILE"; then
        sed -i "/case 'use_avpf':/i \                        case 'inband_progress':\n                        case 'inbandprogress':\n                            \$output1[]='inband_progress='.\$result2['data'];\n                            break;" "$FUNCTIONS_FILE"
    fi
    if ! grep -q "\$devopts\['inband_progress'\]" "$FUNCTIONS_FILE"; then
        sed -i "/\$devopts\['use_avpf'\]\['value'\]='yes';/a \                \$devopts\['inband_progress'\]\['value'\]='yes';" "$FUNCTIONS_FILE"
    fi
    echo "  IssabelPBX PJSIP generator patched for maxcontacts, inband_progress, and remove_unavailable"
fi

# Multi-device & zero-drop registration support for WebRTC extensions
mysql -u root -p"$MYSQL_ROOT_PWD" asterisk -e "
UPDATE sip SET data='10' WHERE keyword IN ('maxcontacts','max_contacts') AND id IN (SELECT id FROM (SELECT id FROM sip WHERE keyword='webrtc' AND data='yes') AS w);
INSERT INTO sip (id, keyword, data, flags)
SELECT id, 'inband_progress', 'yes', 18 FROM sip WHERE keyword='webrtc' AND data='yes'
ON DUPLICATE KEY UPDATE data='yes';
INSERT INTO sip (id, keyword, data, flags)
SELECT id, 'remove_existing', 'no', 18 FROM sip WHERE keyword='webrtc' AND data='yes'
ON DUPLICATE KEY UPDATE data='no';
INSERT INTO sip (id, keyword, data, flags)
SELECT id, 'remove_unavailable', 'yes', 18 FROM sip WHERE keyword='webrtc' AND data='yes'
ON DUPLICATE KEY UPDATE data='yes';
INSERT INTO sip (id, keyword, data, flags)
SELECT id, 'direct_media', 'no', 18 FROM sip WHERE keyword='webrtc' AND data='yes'
ON DUPLICATE KEY UPDATE data='no';
" 2>/dev/null || true
/var/lib/asterisk/bin/retrieve_conf 2>/dev/null || true

# Ensure Asterisk socket permissions allow sokrat-softphone service access
if [ -f /etc/asterisk/asterisk.conf ]; then
    if ! grep -q '^astctlpermissions' /etc/asterisk/asterisk.conf; then
        echo "astctlpermissions = 0775" >> /etc/asterisk/asterisk.conf
    else
        sed -i 's/^astctlpermissions.*/astctlpermissions = 0775/' /etc/asterisk/asterisk.conf
    fi
    if ! grep -q '^astctlgroup' /etc/asterisk/asterisk.conf; then
        echo "astctlgroup = asterisk" >> /etc/asterisk/asterisk.conf
    else
        sed -i 's/^astctlgroup.*/astctlgroup = asterisk/' /etc/asterisk/asterisk.conf
    fi
fi

asterisk -rx "pjsip reload" 2>/dev/null || true
asterisk -rx "module load chan_sip.so" 2>/dev/null || true
echo "  PJSIP reloaded, chan_sip loaded"
# ──────────────────────────────────────────────
# Step 9 — Add Required Dialplan Contexts
# ──────────────────────────────────────────────
echo "[9/14] Adding dialplan contexts..."
DIALPLAN_FILE=/etc/asterisk/extensions_custom.conf

# Ensure file exists
touch "$DIALPLAN_FILE"

# Helper: append a block only if its context header is not already present
append_context() {
    local header="$1"
    local label="$2"
    if grep -qF "$header" "$DIALPLAN_FILE"; then
        echo "  $label already present, skipping"
    else
        cat >> "$DIALPLAN_FILE"
        echo "  $label appended"
    fi
}

# Strip old [from-internal-custom], [from-intercom-autoanswer], [intercom-predial-autoanswer], [from-intercom-conf] before appending
echo "  Stripping old dialplan custom contexts..."
python3 -c "import re;f=open('/etc/asterisk/extensions_custom.conf').read();f=re.sub(r'\[from-internal-custom\].*?(?=\n\[|\Z)', '', f, flags=re.DOTALL);f=re.sub(r'\[from-intercom-autoanswer\].*?(?=\n\[|\Z)', '', f, flags=re.DOTALL);f=re.sub(r'\[intercom-predial-autoanswer\].*?(?=\n\[|\Z)', '', f, flags=re.DOTALL);f=re.sub(r'\[from-intercom-conf\].*?(?=\n\[|\Z)', '', f, flags=re.DOTALL);open('/etc/asterisk/extensions_custom.conf','w').write(f)"
echo "  Stripped."

# Append Intercom, ChanSpy & Hijack from-internal-custom
append_context '[from-internal-custom]' '[from-internal-custom]' << 'CHANSPY'

[from-internal-custom]
; === Sokrat IAX2 VoIP Multi-Server Federation Outbound Hook ===
include => sokrat-federation-out

; === Solution A: Direct 1-to-1 Intercom Code (*80 + Extension, e.g. *80102) ===
exten => _*80X.,1,NoOp(--- Keypad Direct 1-to-1 Intercom to ${EXTEN:3} ---)
same => n,Set(INTERCOM_CALLER=${CALLERID(num)})
same => n,Goto(from-intercom-autoanswer,${EXTEN:3},1)

; === Solution B: All-Available Extensions Mass Intercom Code (*800 or 800) ===
exten => *800,1,NoOp(--- Keypad Mass Intercom to All Available Extensions ---)
same => n,Set(HOST_EXT=${CALLERID(num)})
same => n,Set(ROOM_ID=88${RAND(100000,999999)})
same => n,System(/usr/bin/node /opt/sokrat-voip/scripts/trigger-intercom-code.js ${HOST_EXT} ${ROOM_ID} &)
same => n,Answer()
same => n,ConfBridge(${ROOM_ID})
same => n,Hangup()

exten => 800,1,Goto(*800,1)

exten => _222X.,1,NoOp(Spying on extension ${EXTEN:3} in Listen-only mode)
exten => _222X.,n,Answer()
exten => _222X.,n,Set(spyee_dial=${DB(DEVICE/${EXTEN:3}/dial)})
exten => _222X.,n,GotoIf($["${spyee_dial}" = ""]?fallback)
exten => _222X.,n,ChanSpy(${spyee_dial},q)
exten => _222X.,n,Hangup()
exten => _222X.,n(fallback),ChanSpy(PJSIP/${EXTEN:3},q)
exten => _222X.,n,ChanSpy(SIP/${EXTEN:3},q)
exten => _222X.,n,Hangup()

exten => _223X.,1,NoOp(Spying on extension ${EXTEN:3} in Whisper mode)
exten => _223X.,n,Answer()
exten => _223X.,n,Set(spyee_dial=${DB(DEVICE/${EXTEN:3}/dial)})
exten => _223X.,n,GotoIf($["${spyee_dial}" = ""]?fallback)
exten => _223X.,n,ChanSpy(${spyee_dial},qw)
exten => _223X.,n,Hangup()
exten => _223X.,n(fallback),ChanSpy(PJSIP/${EXTEN:3},qw)
exten => _223X.,n,ChanSpy(SIP/${EXTEN:3},qw)
exten => _223X.,n,Hangup()

exten => _224X.,1,NoOp(Spying on extension ${EXTEN:3} in Barge mode)
exten => _224X.,n,Answer()
exten => _224X.,n,Set(spyee_dial=${DB(DEVICE/${EXTEN:3}/dial)})
exten => _224X.,n,GotoIf($["${spyee_dial}" = ""]?fallback)
exten => _224X.,n,ChanSpy(${spyee_dial},qB)
exten => _224X.,n,Hangup()
exten => _224X.,n(fallback),ChanSpy(PJSIP/${EXTEN:3},qB)
exten => _224X.,n,ChanSpy(SIP/${EXTEN:3},qB)
exten => _224X.,n,Hangup()

exten => _225X.,1,NoOp(--- Instant AGI Hijack Call for Extension ${EXTEN:3} ---)
same => n,Answer()
same => n,AGI(hijack_call.py,${EXTEN:3})
same => n,Hangup()

; === Solution C: Real-Time AI Noise Suppression Live Echo Tests ===
; *88 = RNNoise AI Neural Filter + VAD Gate (100% Dead Silence on Pauses)
exten => *88,1,NoOp(--- RNNoise AI Noise Suppression + VAD Gate Live Echo Test ---)
same => n,Answer()
same => n,Wait(0.5)
same => n,Set(RNNOISE(both,gate=on)=on)
same => n,Playback(beep)
same => n,Echo()
same => n,Hangup()

; *87 = RNNoise AI Neural Filter Continuous (Without VAD Hard Gate)
exten => *87,1,NoOp(--- RNNoise AI Noise Suppression Continuous Echo Test ---)
same => n,Answer()
same => n,Wait(0.5)
same => n,Set(RNNOISE(both,gate=off)=on)
same => n,Playback(beep)
same => n,Echo()
same => n,Hangup()

; *89 = Raw Unfiltered Baseline (Original Audio)
exten => *89,1,NoOp(--- Raw Audio Echo Test (Unfiltered A/B Comparison) ---)
same => n,Answer()
same => n,Wait(0.5)
same => n,Set(RNNOISE(both)=off)
same => n,Playback(beep)
same => n,Echo()
same => n,Hangup()

; === Solution D: Call Pickup Feature Codes (*, *<EXT/GROUP>, **<EXT>, *1 alias, *8 alias) ===
; Directed Call Pickup (**EXT, e.g. **102)
exten => _**X.,1,NoOp(--- Directed Call Pickup for Target ${EXTEN:2} by ${CALLERID(num)} ---)
same => n,PickupChan(PJSIP/${EXTEN:2}&SIP/${EXTEN:2}&Local/${EXTEN:2}@ext-local,p)
same => n,Pickup(${EXTEN:2}@ext-local&${EXTEN:2}@from-internal&${EXTEN:2}@from-did-direct)
same => n,Hangup()

; Directed Call Pickup or Ring Group Intercept (* + Number, e.g. *102 or *600)
exten => _*X.,1,NoOp(--- Directed / Ring Group Pickup for Target ${EXTEN:1} by ${CALLERID(num)} ---)
same => n,PickupChan(PJSIP/${EXTEN:1}&SIP/${EXTEN:1}&Local/${EXTEN:1}@ext-local,p)
same => n,Pickup(${EXTEN:1}@ext-local&${EXTEN:1}@from-internal&${EXTEN:1}@from-did-direct&${EXTEN:1}@ext-group)
same => n,Hangup()

; General Department Group Call Pickup (*)
exten => *,1,NoOp(--- Department Group Call Pickup by ${CALLERID(num)} ---)
same => n,Pickup()
same => n,Hangup()

; Backward Compatibility Aliases (*1, *8, *1X., *8X.)
exten => *1,1,Goto(*,1)
exten => *8,1,Goto(*,1)
exten => _*1X.,1,NoOp(--- Directed Pickup Alias to * ---)
same => n,PickupChan(PJSIP/${EXTEN:2}&SIP/${EXTEN:2}&Local/${EXTEN:2}@ext-local,p)
same => n,Pickup(${EXTEN:2}@ext-local&${EXTEN:2}@from-internal&${EXTEN:2}@from-did-direct&${EXTEN:2}@ext-group)
same => n,Hangup()
exten => _*8X.,1,NoOp(--- Directed Pickup Alias to * ---)
same => n,PickupChan(PJSIP/${EXTEN:2}&SIP/${EXTEN:2}&Local/${EXTEN:2}@ext-local,p)
same => n,Pickup(${EXTEN:2}@ext-local&${EXTEN:2}@from-internal&${EXTEN:2}@from-did-direct&${EXTEN:2}@ext-group)
same => n,Hangup()
CHANSPY

# Append Intercom dialplan contexts
append_context '[from-intercom-autoanswer]' '[from-intercom-autoanswer]' << 'INTERCOM_CTX'

[from-intercom-autoanswer]
exten => _X.,1,NoOp(--- Auto-Answer Intercom Call to ${EXTEN} ---)
same => n,ExecIf($["${INTERCOM_CALLER}" != ""]?Set(CALLERID(name)=Intercom ${INTERCOM_CALLER}):Set(CALLERID(name)=Intercom))
same => n,ExecIf($["${INTERCOM_CALLER}" != ""]?Set(CALLERID(num)=${INTERCOM_CALLER}):Set(CALLERID(num)=226))
same => n,Set(spyee_dial=${DB(DEVICE/${EXTEN}/dial)})
same => n,GotoIf($["${spyee_dial}" = ""]?fallback)
same => n,Dial(${spyee_dial},30,A(beep)b(intercom-predial-autoanswer^s^1))
same => n,Hangup()
same => n(fallback),Dial(PJSIP/${EXTEN},30,A(beep)b(intercom-predial-autoanswer^s^1))
same => n,Dial(SIP/${EXTEN},30,A(beep)b(intercom-predial-autoanswer^s^1))
same => n,Hangup()

[intercom-predial-autoanswer]
exten => s,1,NoOp(--- Predial Auto-Answer SIP Header Injection ---)
same => n,Set(PJSIP_HEADER(add,Call-Info)=<sip:127.0.0.1>\;answer-after=0)
same => n,Set(PJSIP_HEADER(add,Alert-Info)=info=alert-autoanswer)
same => n,SIPAddHeader(Call-Info: <sip:127.0.0.1>\;answer-after=0)
same => n,SIPAddHeader(Alert-Info: info=alert-autoanswer)
same => n,Return()

[from-intercom-conf]
exten => _X.,1,NoOp(--- Intercom Target Join ConfBridge ${EXTEN} ---)
same => n,Answer()
same => n,ConfBridge(${EXTEN})
same => n,Hangup()

INTERCOM_CTX

# Install AGI hijack script & trigger script permissions
echo "  Installing AGI hijack script & scripts..."
mkdir -p /var/lib/asterisk/agi-bin
cp "$INSTALL_DIR/agi-bin/hijack_call.py" /var/lib/asterisk/agi-bin/hijack_call.py
chmod +x /var/lib/asterisk/agi-bin/hijack_call.py
chown asterisk:asterisk /var/lib/asterisk/agi-bin/hijack_call.py
chmod +x "$INSTALL_DIR/scripts/trigger-intercom-code.js" 2>/dev/null || true
echo "  hijack_call.py and scripts initialized."
echo "  Initializing custom sound recordings directory and original master backups..."
mkdir -p /var/lib/asterisk/sounds/custom
chown -R asterisk:asterisk /var/lib/asterisk/sounds/custom 2>/dev/null || true
chmod 775 /var/lib/asterisk/sounds/custom 2>/dev/null || true

for wav in /var/lib/asterisk/sounds/custom/*.wav; do
    [ -f "$wav" ] || continue
    [[ "$wav" == *.orig.wav ]] && continue
    orig="${wav%.wav}.orig.wav"
    if [ ! -f "$orig" ]; then
        cp "$wav" "$orig"
        chown asterisk:asterisk "$orig" 2>/dev/null || true
        chmod 664 "$orig" 2>/dev/null || true
    fi
done
# Strip old [from-dongle-custom] and [ext-moh] before appending (ensures upgrades get the latest version)
echo "  Stripping old [from-dongle-custom] and [ext-moh]..."
python3 -c "import re;f=open('/etc/asterisk/extensions_custom.conf').read();f=re.sub(r'\[from-dongle-custom\].*?(?=\n\[|\Z)', '', f, flags=re.DOTALL);f=re.sub(r'\[ext-moh\].*?(?=\n\[|\Z)', '', f, flags=re.DOTALL);open('/etc/asterisk/extensions_custom.conf','w').write(f)"
echo "  Stripped."

# Append updated from-dongle-custom
cat << 'DONGLE' >> "$DIALPLAN_FILE"

[from-dongle-custom]
exten => sms,1,NoOp(--- Incoming SMS on ${DONGLENAME} ---)
same => n,Verbose(1, [SMS-RECEIVE] Dongle: ${DONGLENAME}, Sender: ${CALLERID(num)}, Content: ${SMS})
same => n,Hangup()

exten => ussd,1,NoOp(--- Incoming USSD on ${DONGLENAME} ---)
same => n,NoOp(USSD Session Type: ${USSD_TYPE})
same => n,NoOp(USSD Content: ${USSD})
same => n,Hangup()

exten => _+X.,1,NoOp(--- Incoming call on ${DONGLENAME} for ${EXTEN} ---)
same => n,ExecIf($["${EXTEN}" != "+1234567890"]?Set(MY_SIM_NUMBER=${EXTEN}))
same => n,Goto(s,process)

exten => _X.,1,NoOp(--- Incoming call on ${DONGLENAME} for ${EXTEN} ---)
same => n,ExecIf($["${EXTEN}" != "+1234567890"]?Set(MY_SIM_NUMBER=${EXTEN}))
same => n,Goto(s,process)

exten => s,1,Set(DONGLE_TARGET=${DONGLENAME})
same => n,Set(CHANNEL(hangup_handler_push)=cdr-cause-capture,s,1)
same => n,Set(CHANNEL(hangup_handler_push)=dongle-hangup-cleanup,s,1)
same => n,ExecIf($["${MY_SIM_NUMBER}" = "" | "${MY_SIM_NUMBER}" = "+1234567890"]?Set(MY_SIM_NUMBER=))
same => n(process),NoOp(--- Incoming call from Dongle ${DONGLENAME} (EXTEN: ${EXTEN}) ---)
same => n,ExecIf($["${DB(DONGLE_SETTINGS/${DONGLENAME})}" != "1"]?Goto(skip_dynamic))
same => n,ExecIf($["${MY_SIM_NUMBER}" = "" | "${MY_SIM_NUMBER}" = "s" | "${MY_SIM_NUMBER}" = "+1234567890"]?Set(MY_SIM_NUMBER=${DB(dongle_map/${DONGLENAME})}))
same => n,ExecIf($["${MY_SIM_NUMBER}" = "" | "${MY_SIM_NUMBER}" = "s" | "${MY_SIM_NUMBER}" = "+1234567890"]?Set(MY_SIM_NUMBER=${DB(DONGLE_NUMBERS/${DONGLEIMSI})}))
same => n,ExecIf($["${MY_SIM_NUMBER}" = "" | "${MY_SIM_NUMBER}" = "s" | "${MY_SIM_NUMBER}" = "+1234567890"]?Set(MY_SIM_NUMBER=${DB(sim_map/${DONGLEIMSI})}))
same => n,ExecIf($["${MY_SIM_NUMBER}" = "" | "${MY_SIM_NUMBER}" = "s" | "${MY_SIM_NUMBER}" = "+1234567890"]?Set(MY_SIM_NUMBER=${DB(DONGLE_NUMBERS/${DONGLEIMEI})}))
same => n(skip_dynamic),ExecIf($["${MY_SIM_NUMBER}" = "" | "${MY_SIM_NUMBER}" = "+1234567890"]?Set(MY_SIM_NUMBER=${EXTEN}))

same => n,Set(CALLER_NUMBER=${FILTER(0123456789+,${CALLERID(num)})})
same => n,Set(CLEAN_CALLER=${FILTER(0123456789,${CALLER_NUMBER})})
same => n,NoOp(Caller Number: ${CALLER_NUMBER})
same => n,ExecIf($["${DB(blacklist/${CALLER_NUMBER})}" != "" | "${DB(blacklist/${CLEAN_CALLER})}" != "" | "${DB(blacklist/+${CLEAN_CALLER})}" != "" | "${DB(blacklist/0${CLEAN_CALLER})}" != ""]?Goto(blacklisted))
same => n,Set(FOUND_NAME=${SHELL(sqlite3 /var/www/db/address_book.db "SELECT name || ' ' || last_name FROM contact WHERE (replace(replace(replace(replace(replace(telefono,'-',''),' ',''),'(',''),')',''),'.','') = '${CALLER_NUMBER}' OR '${CALLER_NUMBER}' LIKE '%' || replace(replace(replace(replace(replace(telefono,'-',''),' ',''),'(',''),')',''),'.','') OR replace(replace(replace(replace(replace(telefono,'-',''),' ',''),'(',''),')',''),'.','') LIKE '%${CALLER_NUMBER}') AND length(replace(replace(replace(replace(replace(telefono,'-',''),' ',''),'(',''),')',''),'.','')) >= 5 LIMIT 1" | tr -d '\n')})
same => n,GotoIf($["${FOUND_NAME}" = ""]?skip_cid)
same => n,NoOp(Found Contact Name: ${FOUND_NAME})
same => n,Set(CALLERID(name)=${FOUND_NAME})
same => n(skip_cid),GotoIf($["${MY_SIM_NUMBER}" != "" & "${MY_SIM_NUMBER}" != "s" & "${MY_SIM_NUMBER}" != "+1234567890"]?goto_did:goto_s)
same => n(goto_did),Goto(from-trunk,${MY_SIM_NUMBER},1)
same => n(goto_s),Goto(from-trunk,s,1)
same => n(blacklisted),NoOp(--- INBOUND CALL REJECTED BY BLACKLIST RULE: ${CALLER_NUMBER} ---)
same => n,Answer()
same => n,Wait(1)
same => n,Zapateller()
same => n,Playback(ss-noservice)
same => n,Hangup()
[ext-moh]
exten => _!,1,NoOp(--- Class-Aware Music On Hold: ${EXTEN} ---)
same => n,Answer()
same => n,Set(CHANNEL(musicclass)=${EXTEN})
same => n,MusicOnHold(${EXTEN})
same => n,Hangup()
DONGLE

# Strip old [macro-dialout-trunk-predial-hook] before appending
echo "  Stripping old [macro-dialout-trunk-predial-hook]..."
python3 -c "import re;f=open('/etc/asterisk/extensions_custom.conf').read();f=re.sub(r'\\[macro-dialout-trunk-predial-hook\\].*?(?=\\n\\[|\\Z)', '', f, flags=re.DOTALL);open('/etc/asterisk/extensions_custom.conf','w').write(f)"
echo "  Stripped."

# Append macro-dialout-trunk-predial-hook
append_context '[macro-dialout-trunk-predial-hook]' '[macro-dialout-trunk-predial-hook]' << 'MACRO'

[macro-dialout-trunk-predial-hook]
exten => s,1,NoOp(--- Outbound call via Dongle (CID auto-set by trunk outcid & Extension RNNoise Filter) ---)
same => n,Set(CALLER_DENOISE=${DB(AMPUSER/${REALCALLERIDNUM}/ai_denoise)})
same => n,ExecIf($["${CALLER_DENOISE}" = ""]?Set(CALLER_DENOISE=${DB(AMPUSER/${CALLERID(num)}/ai_denoise)}))
same => n,ExecIf($["${CALLER_DENOISE}" = ""]?Set(CALLER_DENOISE=both))
same => n,Set(CALLER_VAD=${DB(AMPUSER/${REALCALLERIDNUM}/vad_gate)})
same => n,ExecIf($["${CALLER_VAD}" = ""]?Set(CALLER_VAD=${DB(AMPUSER/${CALLERID(num)}/vad_gate)}))
same => n,Set(CALLER_VAD_DB=${DB(AMPUSER/${REALCALLERIDNUM}/vad_db)})
same => n,ExecIf($["${CALLER_VAD_DB}" = ""]?Set(CALLER_VAD_DB=${DB(AMPUSER/${CALLERID(num)}/vad_db)}))
same => n,ExecIf($["${CALLER_VAD_DB}" = "" | "${CALLER_VAD_DB}" = "off" | "${CALLER_VAD_DB}" = "0"]?Set(CALLER_VAD_DB=${DB(AUDIO_GLOBALS/vad_db_threshold)}))
same => n,ExecIf($["${CALLER_VAD_DB}" = "" | "${CALLER_VAD_DB}" = "off"]?Set(CALLER_VAD_DB=-90))
same => n,Set(U_THRESH=${DB(AUDIO_GLOBALS/vad_threshold)})
same => n,ExecIf($["${U_THRESH}" = ""]?Set(U_THRESH=0.20))
same => n,Set(U_HANG=${DB(AUDIO_GLOBALS/vad_hangover)})
same => n,ExecIf($["${U_HANG}" = ""]?Set(U_HANG=250))
same => n,ExecIf($["${CALLER_VAD}" = "0"]?Set(VAD_OPT=gate=off):Set(VAD_OPT=gate=on,threshold=${U_THRESH},hangover=${U_HANG},mindb=${CALLER_VAD_DB}))
same => n,ExecIf($["${CALLER_DENOISE}" != "off"]?Set(RNNOISE(${CALLER_DENOISE},${VAD_OPT})=on))
same => n,Set(JITTERBUFFER(adaptive)=default)
same => n,Set(RAW_TARGET=${CUT(OUT_${DIAL_TRUNK},/,2)})
same => n,Set(DONGLE_TARGET=${DB(DONGLE_DEVICE_MAP/${RAW_TARGET})})
same => n,ExecIf($["${DONGLE_TARGET}"=""]?Set(DONGLE_TARGET=${RAW_TARGET}))
same => n,Set(CHANNEL(hangup_handler_push)=cdr-cause-capture,s,1)
same => n,Set(CHANNEL(hangup_handler_push)=dongle-hangup-cleanup,s,1)
same => n,MacroExit()

[dongle-hangup-cleanup]
exten => s,1,NoOp(--- Pure Dialplan Dongle Hangup Cleanup ---)
same => n,GotoIf($["${BLINDTRANSFER}"!=""]?done)
same => n,GotoIf($["${ATTENDEDTRANSFER}"!=""]?done)
same => n,GotoIf($["${TRANSFER_CONTEXT}"!=""]?done)
same => n,ExecIf($["${DONGLE_TARGET}"=""]?Set(DONGLE_TARGET=${CUT(CHANNEL,-,1)}))
same => n,ExecIf($["${DONGLE_TARGET:0:7}"="Dongle/"]?Set(DONGLE_TARGET=${DONGLE_TARGET:7}))
same => n,ExecIf($["${DB_EXISTS(DONGLE_DEVICE_MAP/${DONGLE_TARGET})}"="1"]?Set(DONGLE_TARGET=${DB(DONGLE_DEVICE_MAP/${DONGLE_TARGET})}))
same => n,GotoIf($["${DONGLE_TARGET}"="" | "${DONGLE_TARGET:0:6}"!="dongle"]?done)
same => n,Verbose(1, [DONGLE-DIALPLAN-CLEANUP] Resetting dongle ${DONGLE_TARGET} via dialplan System call (Cause: ${HANGUPCAUSE}, DialStatus: ${DIALSTATUS}))
same => n,NoOp([DONGLE-DIALPLAN-CLEANUP] Restart disabled for ${DONGLE_TARGET})
same => n(done),Return()
MACRO

# Append CDR hangup-cause capture subroutine
append_context '[cdr-cause-capture]' '[cdr-cause-capture]' << 'CAUSECAP'

[cdr-cause-capture]
; Persist the Q.850 hangup cause on monitored channels so Call History can
; distinguish busy / no-answer / congestion instead of relying on driver defaults.
exten => s,1,Set(CDR(userfield)=${HANGUPCAUSE})
same => n,Return()

CAUSECAP
# Strip old [macro-dialout-one-predial-hook] before appending
echo "  Stripping old [macro-dialout-one-predial-hook]..."
python3 -c "import re;f=open('/etc/asterisk/extensions_custom.conf').read();f=re.sub(r'\\[macro-dialout-one-predial-hook\\].*?(?=\\n\\[|\\Z)', '', f, flags=re.DOTALL);open('/etc/asterisk/extensions_custom.conf','w').write(f)"
echo "  Stripped."

# Append macro-dialout-one-predial-hook
append_context '[macro-dialout-one-predial-hook]' '[macro-dialout-one-predial-hook]' << 'ONEHOOK'

[macro-dialout-one-predial-hook]
exten => s,1,NoOp(--- Dynamic Adaptive Jitter Buffer & RNNoise Filter for Outbound Extension Leg ---)
same => n,Set(CALLER_DENOISE=${DB(AMPUSER/${CALLERID(num)}/ai_denoise)})
same => n,ExecIf($["${CALLER_DENOISE}" = ""]?Set(CALLER_DENOISE=both))
same => n,Set(CALLER_VAD=${DB(AMPUSER/${CALLERID(num)}/vad_gate)})
same => n,Set(CALLER_VAD_DB=${DB(AMPUSER/${CALLERID(num)}/vad_db)})
same => n,ExecIf($["${CALLER_VAD_DB}" = "" | "${CALLER_VAD_DB}" = "off" | "${CALLER_VAD_DB}" = "0"]?Set(CALLER_VAD_DB=${DB(AUDIO_GLOBALS/vad_db_threshold)}))
same => n,ExecIf($["${CALLER_VAD_DB}" = "" | "${CALLER_VAD_DB}" = "off"]?Set(CALLER_VAD_DB=-90))
same => n,Set(U_THRESH=${DB(AUDIO_GLOBALS/vad_threshold)})
same => n,ExecIf($["${U_THRESH}" = ""]?Set(U_THRESH=0.20))
same => n,Set(U_HANG=${DB(AUDIO_GLOBALS/vad_hangover)})
same => n,ExecIf($["${U_HANG}" = ""]?Set(U_HANG=250))
same => n,ExecIf($["${CALLER_VAD}" = "0"]?Set(VAD_OPT=gate=off):Set(VAD_OPT=gate=on,threshold=${U_THRESH},hangover=${U_HANG},mindb=${CALLER_VAD_DB}))
same => n,ExecIf($["${CALLER_DENOISE}" != "off"]?Set(RNNOISE(${CALLER_DENOISE},${VAD_OPT})=on))
same => n,Set(JITTERBUFFER(adaptive)=default)
same => n,Set(CHANNEL(hangup_handler_push)=cdr-cause-capture,s,1)
same => n,MacroExit()

ONEHOOK

# Strip old [func-apply-sipheaders-custom] before appending
echo "  Stripping old [func-apply-sipheaders-custom]..."
python3 -c "import re;f=open('/etc/asterisk/extensions_custom.conf').read();f=re.sub(r'\[func-apply-sipheaders-custom\].*?(?=\n\[|\Z)', '', f, flags=re.DOTALL);open('/etc/asterisk/extensions_custom.conf','w').write(f)"
echo "  Stripped."

# Append func-apply-sipheaders-custom
append_context '[func-apply-sipheaders-custom]' '[func-apply-sipheaders-custom]' << 'SIPHEADER'

[func-apply-sipheaders-custom]
exten => s,1,NoOp(--- SIP Client Incoming Leg & AI Denoise Hook ---)
same => n,Set(CALLEE_EXT=${DEXTEN})
same => n,ExecIf($["${CALLEE_EXT}" = ""]?Set(CALLEE_EXT=${EXTTOCALL}))
same => n,ExecIf($["${CALLEE_EXT}" = ""]?Set(CALLEE_EXT=${CUT(CUT(CHANNEL,-,1),/,2)}))
same => n,ExecIf($["${SOKRAT_CALL_ID}"!=""]?Set(PJSIP_HEADER(add,X-Sokrat-Call-ID)=${SOKRAT_CALL_ID}))
same => n,ExecIf($["${SOKRAT_CALL_ID}"!=""]?NoOp([callId=${SOKRAT_CALL_ID}] injected X-Sokrat-Call-ID for callee=${CALLEE_EXT}))
same => n,Set(CALLEE_DENOISE=${DB(AMPUSER/${CALLEE_EXT}/ai_denoise)})
same => n,ExecIf($["${CALLEE_DENOISE}" = ""]?Set(CALLEE_EXT=${DB(DEVICE/${CALLEE_EXT}/user)}))
same => n,ExecIf($["${CALLEE_DENOISE}" = ""]?Set(CALLEE_DENOISE=${DB(AMPUSER/${CALLEE_EXT}/ai_denoise)}))
same => n,ExecIf($["${CALLEE_DENOISE}" = ""]?Set(CALLEE_DENOISE=both))
same => n,Set(CALLEE_VAD=${DB(AMPUSER/${CALLEE_EXT}/vad_gate)})
same => n,Set(CALLEE_VAD_DB=${DB(AMPUSER/${CALLEE_EXT}/vad_db)})
same => n,ExecIf($["${CALLEE_VAD_DB}" = "" | "${CALLEE_VAD_DB}" = "off" | "${CALLEE_VAD_DB}" = "0"]?Set(CALLEE_VAD_DB=${DB(AUDIO_GLOBALS/vad_db_threshold)}))
same => n,ExecIf($["${CALLEE_VAD_DB}" = "" | "${CALLEE_VAD_DB}" = "off"]?Set(CALLEE_VAD_DB=-90))
same => n,Set(U_THRESH=${DB(AUDIO_GLOBALS/vad_threshold)})
same => n,ExecIf($["${U_THRESH}" = ""]?Set(U_THRESH=0.20))
same => n,Set(U_HANG=${DB(AUDIO_GLOBALS/vad_hangover)})
same => n,ExecIf($["${U_HANG}" = ""]?Set(U_HANG=250))
same => n,ExecIf($["${CALLEE_VAD}" = "0"]?Set(VAD_OPT=gate=off):Set(VAD_OPT=gate=on,threshold=${U_THRESH},hangover=${U_HANG},mindb=${CALLEE_VAD_DB}))
same => n,ExecIf($["${CALLEE_DENOISE}" != "off"]?Set(RNNOISE(${CALLEE_DENOISE},${VAD_OPT})=on))
; Rule 1: Do not mask internal extension-to-extension calls (e.g. 101 calling 102)
same => n,GotoIf($[${LEN(${CALLERID(num)})} <= 4]?done)
same => n,GotoIf($["${DB_EXISTS(AMPUSER/${CALLERID(num)}/cidname)}" = "1"]?done)

; Rule 2: Skip masking if caller ID is anonymous, unavailable, unknown, or restricted
same => n,GotoIf($["${CALLERID(num)}" = "" | "${CALLERID(num)}" = "anonymous" | "${CALLERID(num)}" = "unknown" | "${CALLERID(num)}" = "s" | "${CALLERID(num)}" = "unavailable" | "${CALLERID(num)}" = "restricted"]?done)

; Rule 3: Skip if caller ID is too short to mask (needs at least 6 digits)
same => n,Set(RAW_NUM=${CALLERID(num)})
same => n,Set(NUM_LEN=${LEN(${RAW_NUM})})
same => n,GotoIf($[${NUM_LEN} < 6]?done)

; Rule 4: Check if destination extension has unmask_cid enabled in AstDB
same => n,Set(TARGET_EXT=${DEXTEN})
same => n,ExecIf($["${TARGET_EXT}" = ""]?Set(TARGET_EXT=${EXTTOCALL}))
same => n,ExecIf($["${TARGET_EXT}" = ""]?Set(TARGET_EXT=${CUT(CUT(CHANNEL,-,1),/,2)}))
same => n,GotoIf($["${TARGET_EXT}" != "" & "${DB(AMPUSER/${TARGET_EXT}/unmask_cid)}" = "1"]?done)
; Rule 5: Extract prefix (first 3 chars) and suffix (last 2 chars)
same => n,Set(CID_PREFIX=${RAW_NUM:0:3})
same => n,Set(CID_SUFFIX=${RAW_NUM:-2})

; Rule 6: Build masked representation (e.g. 010*********23)
same => n,Set(MASKED_NUM=${CID_PREFIX}*********${CID_SUFFIX})

; Rule 7: Apply to CallerID number and name for SIP INVITE
same => n,NoOp(Masking CallerID for SIP Client Display: ${RAW_NUM} -> ${MASKED_NUM})
same => n,Set(CALLERID(num)=${MASKED_NUM})
same => n,ExecIf($["${CALLERID(name)}" != "" & "${CALLERID(name)}" != "${RAW_NUM}"]?Set(CALLERID(name)=${CALLERID(name)} [${MASKED_NUM}]):Set(CALLERID(name)=${MASKED_NUM}))

same => n(done),Return()
SIPHEADER

# Strip old [ext-external-failover] and [sub-failover-screen] before appending
python3 -c "import re;f=open('/etc/asterisk/extensions_custom.conf').read();f=re.sub(r'\[ext-external-failover\].*?(?=\n\[|\Z)', '', f, flags=re.DOTALL);f=re.sub(r'\[sub-failover-screen\].*?(?=\n\[|\Z)', '', f, flags=re.DOTALL);open('/etc/asterisk/extensions_custom.conf','w').write(f)"

# Append ext-external-failover
append_context '[ext-external-failover]' '[ext-external-failover]' << 'FAILOVER_CTX'

[ext-external-failover]
; Sokrat Call Center Failover to External Mobile Number (Direct Bridge)
; Supports:
;   1. Explicit Dongle: ext-external-failover,01011719380/dongle1,1 OR ext-external-failover,01011719380@dongle1,1
;   2. Automatic Outbound Routes: ext-external-failover,01011719380,1
exten => _[0-9+*#].!,1,NoOp(=== SOKRAT FAILOVER: Target '${EXTEN}' for Customer '${CALLERID(num)}' ===)
same => n,Set(CUST_NUM=${CALLERID(num)})
same => n,Set(RAW_TARGET=${EXTEN})
same => n,Set(TARGET_NUM=${CUT(RAW_TARGET,/,1)})
same => n,Set(TARGET_NUM=${CUT(TARGET_NUM,@,1)})
same => n,Set(EXPLICIT_DONGLE=${CUT(RAW_TARGET,/,2)})
same => n,ExecIf($["${EXPLICIT_DONGLE}"=""]?Set(EXPLICIT_DONGLE=${CUT(RAW_TARGET,@,2)}))
same => n,Set(__FAILOVER_DEST=${TARGET_NUM})
same => n,Set(CDR(userfield)=Failover: ${RAW_TARGET})
same => n,GotoIf($["${EXPLICIT_DONGLE}"!=""]?dial_explicit:dial_routes)
same => n(dial_explicit),NoOp(Dialing explicitly via Dongle/${EXPLICIT_DONGLE}/${TARGET_NUM})
same => n,Dial(Dongle/${EXPLICIT_DONGLE}/${TARGET_NUM},60)
same => n,Hangup()
same => n(dial_routes),NoOp(Dialing via Outbound Routes for ${TARGET_NUM})
same => n,Dial(Local/${TARGET_NUM}@outbound-allroutes,60)
same => n,Hangup()
FAILOVER_CTX

# 9a-fed — Sokrat IAX2 Multi-Server PBX Federation Asterisk Config Includes
echo "  Configuring Sokrat Federation Asterisk config includes..."
touch /etc/asterisk/sokrat_federation.conf
touch /etc/asterisk/sokrat_federation_iax.conf
chown asterisk:asterisk /etc/asterisk/sokrat_federation*.conf 2>/dev/null || true
chmod 644 /etc/asterisk/sokrat_federation*.conf 2>/dev/null || true

if ! grep -qF '#include sokrat_federation.conf' /etc/asterisk/extensions_custom.conf 2>/dev/null; then
    echo '' >> /etc/asterisk/extensions_custom.conf
    echo '; Sokrat IAX2 Federation Custom Dialplan Contexts' >> /etc/asterisk/extensions_custom.conf
    echo '#include sokrat_federation.conf' >> /etc/asterisk/extensions_custom.conf
fi

if ! grep -qF '#include sokrat_federation_iax.conf' /etc/asterisk/iax_custom.conf 2>/dev/null; then
    echo '' >> /etc/asterisk/iax_custom.conf
    echo '; Sokrat IAX2 Federation Inbound/Outbound Peer Definitions' >> /etc/asterisk/iax_custom.conf
    echo '#include sokrat_federation_iax.conf' >> /etc/asterisk/iax_custom.conf
fi

asterisk -rx "iax2 reload" 2>/dev/null || true

asterisk -rx "dialplan reload" 2>/dev/null || true
echo "  Dialplan reloaded"

# 9b — Configure Asterisk Voicemail Storage Limits (maxmsg=1000, maxsecs=300)
echo "  Configuring Asterisk voicemail storage limits (maxmsg=1000, maxsecs=300)..."
if [ -f /etc/asterisk/vm_general.inc ]; then
    sed -i '/^maxmsg=/d' /etc/asterisk/vm_general.inc
    sed -i '/^maxsecs=/d' /etc/asterisk/vm_general.inc
    sed -i '/^minsecs=/d' /etc/asterisk/vm_general.inc
    echo "maxmsg=1000" >> /etc/asterisk/vm_general.inc
    echo "maxsecs=300" >> /etc/asterisk/vm_general.inc
    echo "minsecs=3" >> /etc/asterisk/vm_general.inc
fi
if [ -f /etc/asterisk/voicemail.conf ]; then
    sed -i '/^maxmsg=/d' /etc/asterisk/voicemail.conf
    sed -i '/^maxsecs=/d' /etc/asterisk/voicemail.conf
    sed -i '/^minsecs=/d' /etc/asterisk/voicemail.conf
    if grep -q '^\[general\]' /etc/asterisk/voicemail.conf; then
        sed -i '/^\[general\]/a maxmsg=1000\nmaxsecs=300\nminsecs=3' /etc/asterisk/voicemail.conf
    fi
fi
asterisk -rx "voicemail reload" 2>/dev/null || true
echo "  Voicemail storage limit set to 1000 messages per mailbox"

# ──────────────────────────────────────────────
# Step 10 — GSM Dongle Setup
# ──────────────────────────────────────────────
echo ""
echo "[10/14] Setting up GSM dongles & chan_dongle..."

# 10a — Install Build Dependencies
echo "  [10a] Installing build dependencies..."
if ! command -v gcc &>/dev/null || ! command -v make &>/dev/null; then
    yum -y install gcc gcc-c++ make automake autoconf libtool sqlite-devel usbutils usb_modeswitch minicom wget curl tar patch asterisk18-devel 2>/dev/null || true
fi

# 10b — Compile and Install librnnoise & func_rnnoise.so
echo "  [10b] Compiling librnnoise and func_rnnoise.so..."
if [ ! -f /usr/lib64/librnnoise.so ] || [ ! -f /usr/include/rnnoise.h ]; then
    echo "  Attempting librnnoise compilation with timeout fallback..."
    cd /tmp
    rm -rf rnnoise_build
    mkdir -p rnnoise_build && cd rnnoise_build
    if git clone --depth 1 https://github.com/xiph/rnnoise.git 2>/dev/null; then
        cd rnnoise
        chmod +x autogen.sh download_model.sh 2>/dev/null || true
        ./autogen.sh 2>/dev/null || true
        if timeout 30 ./download_model.sh 2>/dev/null; then
            ./configure --prefix=/usr --libdir=/usr/lib64 CFLAGS="-O3" 2>/dev/null || true
            make -j$(nproc) 2>/dev/null && make install 2>/dev/null && ldconfig || true
            echo "  librnnoise compiled and installed"
        fi
    fi
fi
if [ -f /usr/lib64/librnnoise.so ]; then
    echo "  librnnoise already installed"
else
    echo "  librnnoise optional; proceeding without hardware noise cancellation"
fi
if [ -f "$INSTALL_DIR/asterisk/func_rnnoise.c" ] && [ -f /usr/lib64/librnnoise.so ] && [ -f /usr/include/rnnoise.h ]; then
    gcc -shared -fPIC -O3 -mavx2 -mfma -I/usr/include -o /usr/lib64/asterisk/modules/func_rnnoise.so \
        "$INSTALL_DIR/asterisk/func_rnnoise.c" -lrnnoise -lm -lpthread 2>/dev/null || true
    chmod 755 /usr/lib64/asterisk/modules/func_rnnoise.so 2>/dev/null || true
    asterisk -rx "module load func_rnnoise.so" 2>/dev/null || asterisk -rx "module reload func_rnnoise.so" 2>/dev/null || true
    echo "  func_rnnoise.so compiled and loaded into Asterisk"
fi
# 10c — Compile and Install chan_dongle (with Sokrat decline detection and SMS ME storage patches)
echo "  [10c] Installing chan_dongle..."
if [ -f "/tmp/sokrat-repo/installer-bundle/binaries/chan_dongle.so" ]; then
    mkdir -p /usr/lib64/asterisk/modules
    cp "/tmp/sokrat-repo/installer-bundle/binaries/chan_dongle.so" /usr/lib64/asterisk/modules/chan_dongle.so
    chmod 644 /usr/lib64/asterisk/modules/chan_dongle.so
    echo "  chan_dongle.so installed from bundle"
elif [ -f /usr/lib64/asterisk/modules/chan_dongle.so ]; then
    echo "  chan_dongle.so already installed"
else
    cd /usr/src
    if [ ! -d asterisk-chan-dongle ]; then
        git clone https://github.com/wdoekes/asterisk-chan-dongle.git 2>/dev/null || true
    fi
    if [ -d asterisk-chan-dongle ]; then
        cd asterisk-chan-dongle
        if [ -f "$INSTALL_DIR/asterisk/chan_dongle.patch" ]; then
            patch -p1 < "$INSTALL_DIR/asterisk/chan_dongle.patch" 2>/dev/null || true
        fi
        ./bootstrap 2>/dev/null || true
        ./configure --with-astversion=18.19.0 2>/dev/null || true
        make -j$(nproc 2>/dev/null || echo 1) 2>/dev/null && make install 2>/dev/null || true
        echo "  chan_dongle compiled and installed"
    fi
fi
# 10d — Configure and apply dongle.conf
echo "  [10d] Configuring and applying dongle.conf..."
if [ -f /etc/asterisk/dongle.conf ] && grep -q '^\[dongle0\]' /etc/asterisk/dongle.conf; then
    echo "  /etc/asterisk/dongle.conf already exists, preserving existing port & SIM configuration..."
    cp -a /etc/asterisk/dongle.conf /etc/asterisk/dongle.conf.bak-install 2>/dev/null || true
    if grep -q '^;callwaiting=' /etc/asterisk/dongle.conf; then
        sed -i 's/^;callwaiting=.*/callwaiting=no/' /etc/asterisk/dongle.conf
    elif ! grep -q '^callwaiting=' /etc/asterisk/dongle.conf; then
        sed -i '/^\[defaults\]/a callwaiting=no' /etc/asterisk/dongle.conf
    fi
else
    echo "  Configuring $NUM_DONGLES dongle(s)..."
    TEMP_CONF="/tmp/dongle.conf.tmp"
    rm -f "$TEMP_CONF"
    sed -n '1,/^\[dongle0\]/ { /^\[dongle0\]/! p }' "$INSTALL_DIR/dongle.conf" > "$TEMP_CONF"
    for ((i=0; i<NUM_DONGLES; i++)); do
        audio_port=$((i * 3 + 1))
        data_port=$((i * 3 + 2))
        cat >> "$TEMP_CONF" << EOF

[dongle$i]
txgain=3
rxgain=3
audio=/dev/ttyUSB$audio_port
data=/dev/ttyUSB$data_port
imei=
imsi=
EOF
    done
    cp "$TEMP_CONF" /etc/asterisk/dongle.conf
    rm -f "$TEMP_CONF"
    echo "  dongle.conf successfully generated with $NUM_DONGLES dongle(s) at /etc/asterisk/dongle.conf"
fi

# 10d2 — Ensure /var/log/asterisk/full captures VERBOSE messages (required for SMS/USSD parsing)
echo "  [10d2] Enabling verbose logging in Asterisk logger.conf..."
if grep -q '^full\s*=>' /etc/asterisk/logger.conf; then
    if ! grep -q 'verbose' /etc/asterisk/logger.conf; then
        sed -i 's/^\(full\s*=>.*\)/\1,verbose/' /etc/asterisk/logger.conf
        echo "  verbose added to full log channel"
    else
        echo "  verbose already in full log channel"
    fi
fi

# 10e — Permissions, udev & USB Autosuspend Disable
echo "  [10e] Configuring permissions, udev, and disabling USB autosuspend..."
usermod -a -G lock,dialout asterisk
chgrp asterisk /run/lock 2>/dev/null || true
chmod 775 /run/lock 2>/dev/null || true

cat > /etc/tmpfiles.d/legacy.conf << 'TMPFILES'
d /run/lock 0775 root asterisk -
L /var/lock - - - - ../run/lock
d /run/lock/subsys 0755 root root -
r! /forcefsck
r! /fastboot
r! /forcequotacheck
TMPFILES
echo "  tmpfiles.d configured"

# Install udev rules from repo (permissions for all ttyUSB*)
cp "$INSTALL_DIR/rules/99-huawei-dongle.rules" /etc/udev/rules.d/99-huawei-dongle.rules
chmod 644 /etc/udev/rules.d/99-huawei-dongle.rules
echo "  99-huawei-dongle.rules installed"

cp "$INSTALL_DIR/rules/99-dongle-auto-restart.rules" /etc/udev/rules.d/99-dongle-auto-restart.rules
chmod 644 /etc/udev/rules.d/99-dongle-auto-restart.rules
echo "  99-dongle-auto-restart.rules installed"
# Disable USB autosuspend in GRUB kernel command line
if [ -f /etc/default/grub ]; then
    if ! grep -q 'usbcore.autosuspend=-1' /etc/default/grub; then
        echo "  Configuring GRUB to disable USB autosuspend..."
        sed -i 's/GRUB_CMDLINE_LINUX="\(.*\)"/GRUB_CMDLINE_LINUX="\1 usbcore.autosuspend=-1"/' /etc/default/grub
        if [ -f /boot/grub2/grub.cfg ]; then
            grub2-mkconfig -o /boot/grub2/grub.cfg 2>/dev/null || true
        fi
        if [ -f /boot/efi/EFI/centos/grub.cfg ]; then
            grub2-mkconfig -o /boot/efi/EFI/centos/grub.cfg 2>/dev/null || true
        fi
        if [ -f /boot/efi/EFI/redhat/grub.cfg ]; then
            grub2-mkconfig -o /boot/efi/EFI/redhat/grub.cfg 2>/dev/null || true
        fi
        echo "  GRUB updated with usbcore.autosuspend=-1"
    else
        echo "  GRUB already configured with usbcore.autosuspend=-1"
    fi
fi

# Disable USB autosuspend via modprobe & udev rules
echo "options usbcore autosuspend=-1" > /etc/modprobe.d/usbcore.conf
echo 'ACTION=="add", SUBSYSTEM=="usb", ATTR{power/control}="on"' > /etc/udev/rules.d/99-disable-usb-autosuspend.rules

# Live apply USB autosuspend disable immediately
echo -1 > /sys/module/usbcore/parameters/autosuspend 2>/dev/null || true
for dev in /sys/bus/usb/devices/*/power/control; do
    echo "on" > "$dev" 2>/dev/null || true
done
# Remove old dongle-auto-reload.service if it exists
systemctl stop dongle-auto-reload.service 2>/dev/null || true
systemctl disable dongle-auto-reload.service 2>/dev/null || true
rm -f /etc/systemd/system/dongle-auto-reload.service
echo "  Old dongle-auto-reload.service removed"

# 10f — Reload and restart
echo "  [10f] Clearing stale lock files, reloading rules, and restarting Asterisk..."
rm -f /var/lock/LCK..* /run/lock/LCK..* 2>/dev/null || true
chmod 666 /dev/ttyUSB* 2>/dev/null || true
systemctl daemon-reload
udevadm control --reload-rules 2>/dev/null || true
udevadm trigger 2>/dev/null || true
systemctl restart asterisk
echo "  Asterisk restarted"

# 10g — Initialize sim_mappings.json
echo "  [10g] Initializing sim_mappings.json..."
if [ ! -f "$INSTALL_DIR/sim_mappings.json" ]; then
    echo '{}' > "$INSTALL_DIR/sim_mappings.json"
    chmod 644 "$INSTALL_DIR/sim_mappings.json"
    echo "  sim_mappings.json created"
else
    echo "  sim_mappings.json already exists"
fi

# 10h — Initialize AstDB Noise & Audio Defaults
echo "  [10h] Initializing AstDB Noise and Audio defaults..."
asterisk -rx "database put AUDIO_GLOBALS vad_threshold 0.20" 2>/dev/null || true
asterisk -rx "database put AUDIO_GLOBALS vad_hangover 250" 2>/dev/null || true
asterisk -rx "database put AUDIO_GLOBALS vad_db_threshold -90" 2>/dev/null || true
for ext in $(asterisk -rx "database show AMPUSER" 2>/dev/null | grep "/cidname" | awk -F'/' '{print $2}' | sort -u); do
    curr_denoise=$(asterisk -rx "database get AMPUSER $ext/ai_denoise" 2>/dev/null | grep "Value:" | awk '{print $2}')
    if [ -z "$curr_denoise" ]; then
        asterisk -rx "database put AMPUSER $ext/ai_denoise both" 2>/dev/null || true
    fi
    curr_vad=$(asterisk -rx "database get AMPUSER $ext/vad_gate" 2>/dev/null | grep "Value:" | awk '{print $2}')
    if [ -z "$curr_vad" ]; then
        asterisk -rx "database put AMPUSER $ext/vad_gate 1" 2>/dev/null || true
    fi
    curr_vad_db=$(asterisk -rx "database get AMPUSER $ext/vad_db" 2>/dev/null | grep "Value:" | awk '{print $2}')
    if [ -z "$curr_vad_db" ]; then
        asterisk -rx "database put AMPUSER $ext/vad_db off" 2>/dev/null || true
    fi
done
echo "  AstDB Noise and Audio defaults initialized"

# ──────────────────────────────────────────────
# Step 11 — Configure Apache Reverse Proxy
# ──────────────────────────────────────────────
echo "[11/14] Configuring Apache reverse proxy..."
yum install -y mod_ssl 2>/dev/null || true

# Restore Listen 80 in httpd.conf if it was replaced, and ensure Listen 3000 is present
if ! grep -q '^Listen 80' /etc/httpd/conf/httpd.conf; then
    if grep -q '^Listen 3000' /etc/httpd/conf/httpd.conf; then
        sed -i 's/^Listen 3000/Listen 80/' /etc/httpd/conf/httpd.conf
        echo "  Restored Listen 80 in httpd.conf"
    else
        echo "Listen 80" >> /etc/httpd/conf/httpd.conf
        echo "  Added Listen 80 to httpd.conf"
    fi
fi

# Ensure Listen 3000 is present (so Issabel GUI can run on port 3000)
if ! grep -q '^Listen 3000' /etc/httpd/conf/httpd.conf; then
    sed -i '/^Listen 80/a Listen 3000' /etc/httpd/conf/httpd.conf
    echo "  Listen 3000 added to httpd.conf"
fi

# Create Issabel SSO Bridge for seamless admin auto-login
cat > /var/www/html/sokrat_sso.php << 'SSO_PHP'
<?php
// Sokrat VoIP -> Issabel Single Sign-On (SSO) Bridge
ini_set('include_path', dirname($_SERVER['SCRIPT_FILENAME'])."/libs:".ini_get('include_path'));
include_once("libs/misc.lib.php");
include_once "configs/default.conf.php";
include_once "libs/paloSantoDB.class.php";
include_once "libs/paloSantoACL.class.php";

session_name("issabelSession");
session_start();

$pdbACL = new paloDB($arrConf['issabel_dsn']['acl']);
$pACL = new paloACL($pdbACL);

$user = 'admin';
$pass = 'admin';
$pass_md5 = md5($pass);

if (!$pACL->authenticateUser($user, $pass_md5)) {
    $query = "SELECT md5_password FROM acl_user WHERE name = ?";
    $result = $pdbACL->getFirstRowQuery($query, true, array($user));
    if ($result && isset($result['md5_password'])) {
        $pass_md5 = $result['md5_password'];
    }
}

session_regenerate_id(TRUE);
$_SESSION['issabel_user'] = $user;
$_SESSION['issabel_pass'] = $pass_md5;

header("Location: index.php");
exit;
SSO_PHP
chmod 644 /var/www/html/sokrat_sso.php
chown asterisk:asterisk /var/www/html/sokrat_sso.php 2>/dev/null || true
echo "  Issabel SSO bridge installed at /var/www/html/sokrat_sso.php"

# Remove HTTPS redirect from Issabel vhost (would break proxy)
sed -i '/RewriteEngine On/,/RewriteRule/d' /etc/httpd/conf.d/issabel.conf 2>/dev/null || true
echo "  Issabel HTTPS redirect removed"

# Create dashboard reverse proxy vhost for port 80 with WebSocket support and softphone HTTPS redirect
cat > /etc/httpd/conf.d/dashboard.conf << 'DASHBOARD'
<VirtualHost *:80>
    ProxyPreserveHost On

    RewriteEngine On
    RewriteRule ^/phone(/.*)?$ https://%{HTTP_HOST}:8443/phone$1 [R=301,L]
    RewriteRule ^/standalone-softphone(/.*)?$ https://%{HTTP_HOST}:8443/phone$1 [R=301,L]

    RewriteCond %{HTTP:Upgrade} =websocket [NC]
    RewriteCond %{REQUEST_URI} ^/socket.io [NC]
    RewriteRule /(.*) ws://127.0.0.1:8080/$1 [P,L]

    ProxyPass /socket.io http://127.0.0.1:8080/socket.io
    ProxyPassReverse /socket.io http://127.0.0.1:8080/socket.io

    ProxyPass / http://127.0.0.1:8080/
    ProxyPassReverse / http://127.0.0.1:8080/
</VirtualHost>
DASHBOARD
echo "  dashboard.conf created (port 80 -> :8080 with WebSocket support)"

# Add ProxyPass & WebSocket rewrite to SSL vhost (port 443 -> :8080 & :8090)
sed -i '/ProxyPreserveHost On/d; /RequestHeader set X-Forwarded-Proto/d; /RewriteEngine On/d; /RewriteCond %{HTTP:Upgrade}/d; /RewriteCond %{REQUEST_URI}/d; /RewriteRule.*ws:\/\/127\.0\.0\.1:8080/d; /RewriteRule.*ws:\/\/127\.0\.0\.1:8088/d; /ProxyPass.*8080/d; /ProxyPassReverse.*8080/d; /ProxyPass.*8090/d; /ProxyPassReverse.*8090/d; /ProxyPass.*8088/d; /ProxyPassReverse.*8088/d' /etc/httpd/conf.d/ssl.conf 2>/dev/null || true
sed -i '/^SSLEngine on$/a\    ProxyPreserveHost On\n    RequestHeader set X-Forwarded-Proto "https"\n    RewriteEngine On\n    RewriteCond %{HTTP:Upgrade} =websocket [NC]\n    RewriteCond %{REQUEST_URI} ^/ws [NC]\n    RewriteRule /(.*) ws://127.0.0.1:8088/\$1 [P,L]\n    RewriteCond %{HTTP:Upgrade} =websocket [NC]\n    RewriteCond %{REQUEST_URI} ^/socket.io [NC]\n    RewriteRule /(.*) ws://127.0.0.1:8080/\$1 [P,L]\n    ProxyPass /phone/ http://127.0.0.1:8090/\n    ProxyPassReverse /phone/ http://127.0.0.1:8090/\n    ProxyPass /phone http://127.0.0.1:8090/\n    ProxyPassReverse /phone http://127.0.0.1:8090/\n    ProxyPass /standalone-softphone/ http://127.0.0.1:8090/\n    ProxyPassReverse /standalone-softphone/ http://127.0.0.1:8090/\n    ProxyPass /standalone-softphone http://127.0.0.1:8090/\n    ProxyPassReverse /standalone-softphone http://127.0.0.1:8090/\n    ProxyPass /ws ws://127.0.0.1:8088/ws\n    ProxyPassReverse /ws ws://127.0.0.1:8088/ws\n    ProxyPass /socket.io http://127.0.0.1:8080/socket.io\n    ProxyPassReverse /socket.io http://127.0.0.1:8080/socket.io\n    ProxyPass / http://127.0.0.1:8080/\n    ProxyPassReverse / http://127.0.0.1:8080/' /etc/httpd/conf.d/ssl.conf
echo "  SSL vhost proxied (port 443 -> :8080 dashboard & :8090 softphone)"
# Restart Apache
httpd -t 2>&1 | grep -v 'Could not reliably' | grep -v 'AH00558' || true
systemctl restart httpd
echo "  Apache restarted"

# Configure Standalone WebRTC Softphone Apache VirtualHost (port 8443 -> :8090)
cat > /var/www/html/ssl-redirect.html << 'HTML'
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>Redirecting to HTTPS...</title>
    <script>
        (function() {
            var host = window.location.host;
            var path = window.location.pathname || '/';
            var search = window.location.search || '';
            window.location.replace('https://' + host + path + search);
        })();
    </script>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; text-align: center; padding-top: 60px; background: #07070a; color: #ffffff;">
    <h3 style="margin-bottom: 12px;">Redirecting to Secure HTTPS Connection...</h3>
    <p style="color: #9e9eb0; font-size: 13px;">If you are not redirected automatically, <a id="httpsLink" href="#" style="color: #a855f7; font-weight: bold;">click here to continue</a>.</p>
    <script>
        document.getElementById('httpsLink').href = 'https://' + window.location.host + window.location.pathname + window.location.search;
    </script>
</body>
</html>
HTML

cat > /etc/httpd/conf.d/softphone.conf << 'APACHE'
Listen 8443 https

<VirtualHost *:8443>
    SSLEngine on
    SSLCertificateFile /etc/asterisk/keys/asterisk.pem
    SSLCertificateKeyFile /etc/asterisk/keys/asterisk.pem

    ErrorDocument 400 /ssl-redirect.html
    Alias /ssl-redirect.html /var/www/html/ssl-redirect.html

    ProxyTimeout 86400
    ProxyPreserveHost On
    RequestHeader set X-Forwarded-Proto "https"
    RequestHeader set X-Forwarded-Port "8443"

    RewriteEngine On
    RewriteCond %{HTTP:Upgrade} =websocket [NC]
    RewriteCond %{REQUEST_URI} !^/ws [NC]
    RewriteRule /(.*) ws://127.0.0.1:8090/$1 [P,L]
    ProxyPass /ws ws://127.0.0.1:8088/ws
    ProxyPass /ssl-redirect.html !
    ProxyPass / http://127.0.0.1:8090/
    ProxyPassReverse / http://127.0.0.1:8090/
</VirtualHost>
APACHE
echo "  softphone.conf created (port 8443 -> :8090 with auto-HTTPS redirect & WebSocket support)"

# ──────────────────────────────────────────────
# Step 12 — Create systemd Service
# ──────────────────────────────────────────────
echo "[12/14] Creating systemd services..."
cat > /etc/systemd/system/sokrat-voip.service << 'UNIT'
[Unit]
Description=Issabel Dashboard
After=network.target mysqld.service asterisk.service

[Service]
Type=simple
WorkingDirectory=/opt/sokrat-voip
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
User=root
Environment=NODE_ENV=production
Environment=LANG=en_US.UTF-8
Environment=LC_ALL=en_US.UTF-8

[Install]
WantedBy=multi-user.target
UNIT

# Configure amportal-reload.service with Asterisk readiness pre-check to prevent boot-time AMI race condition
for AMPORTAL_SERVICE in /usr/lib/systemd/system/amportal-reload.service /etc/systemd/system/amportal-reload.service; do
    if [ -f "$AMPORTAL_SERVICE" ]; then
        echo "  Configuring amportal-reload.service with Asterisk readiness pre-check..."
        if ! grep -q "ExecStartPre=" "$AMPORTAL_SERVICE"; then
            sed -i '/\[Service\]/a ExecStartPre=/bin/bash -c '\''for i in $(seq 1 30); do if /usr/sbin/asterisk -rx "core show version" >/dev/null 2>&1; then exit 0; fi; sleep 1; done; exit 0'\''' "$AMPORTAL_SERVICE"
        else
            sed -i 's|^ExecStartPre=.*|ExecStartPre=/bin/bash -c '\''for i in $(seq 1 30); do if /usr/sbin/asterisk -rx "core show version" >/dev/null 2>&1; then exit 0; fi; sleep 1; done; exit 0'\''|' "$AMPORTAL_SERVICE"
        fi
    fi
done

systemctl daemon-reload
systemctl enable --now sokrat-voip
echo "  Service enabled and started"

# Provision Sokrat Standalone WebRTC Softphone Daemon
id -u sokrat-softphone &>/dev/null || useradd -r -s /sbin/nologin -d /opt/sokrat-softphone -c "Sokrat Softphone Daemon" sokrat-softphone
usermod -aG asterisk sokrat-softphone 2>/dev/null || true
chown -R sokrat-softphone:sokrat-softphone /opt/sokrat-softphone 2>/dev/null || true
cat > /etc/systemd/system/sokrat-softphone.service << 'UNIT'
[Unit]
Description=Sokrat Standalone WebRTC Softphone Daemon
After=network.target asterisk.service
Wants=asterisk.service

[Service]
Type=simple
User=sokrat-softphone
Group=sokrat-softphone
WorkingDirectory=/opt/sokrat-softphone
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=3
# Kernel Hardening & Sandbox
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
NoNewPrivileges=true
CapabilityBoundingSet=
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX

# Environment
Environment=NODE_ENV=production
Environment=PORT=8090
Environment=HOST=127.0.0.1

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now sokrat-softphone
echo "  Sokrat softphone daemon enabled and started"

# Provision Sokrat Cloud AI Speech-To-Text Worker Daemon
echo "  Provisioning Sokrat Cloud AI Speech-To-Text Worker..."
cat > /etc/systemd/system/sokrat-stt.service << 'UNIT'
[Unit]
Description=Sokrat VoIP Cloud AI Speech-To-Text Worker
After=network.target mariadb.service mysqld.service asterisk.service
Wants=asterisk.service

[Service]
Type=simple
User=root
WorkingDirectory=/opt/sokrat-voip
ExecStart=/usr/bin/node /opt/sokrat-voip/scripts/stt-worker.js
Restart=always
RestartSec=5
Nice=15
CPUShares=256
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now sokrat-stt 2>/dev/null || true
echo "  Sokrat Cloud AI STT worker daemon enabled and started"

# Provision Sokrat System Watchdog & Alert Daemon
echo "  Provisioning Sokrat System Watchdog & Alert Daemon..."
cat > /etc/systemd/system/sokrat-watchdog.service << 'UNIT'
[Unit]
Description=Sokrat VoIP System Watchdog & Alert Daemon
After=network.target mysqld.service mariadb.service
Wants=mysqld.service mariadb.service

[Service]
Type=simple
WorkingDirectory=/opt/sokrat-voip
ExecStart=/usr/bin/node scripts/system-watchdog.js
Restart=always
RestartSec=10
User=root
Environment=NODE_ENV=production
Environment=LANG=en_US.UTF-8
Environment=LC_ALL=en_US.UTF-8

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now sokrat-watchdog.service 2>/dev/null || true
echo "  Sokrat system watchdog daemon enabled and started"

# Provision Webmin Local Control Panel on Port 3001
echo "  Configuring Webmin Control Panel (Port 3001)..."
if [ ! -f /etc/yum.repos.d/webmin.repo ]; then
    cat > /etc/yum.repos.d/webmin.repo << 'EOF'
[webmin-noarch]
name=Webmin - noarch
baseurl=https://download.webmin.com/download/newkey/yum
enabled=1
gpgcheck=1
gpgkey=https://download.webmin.com/developers-key.asc
EOF
    rpm --import https://download.webmin.com/developers-key.asc 2>/dev/null || true
fi
if ! rpm -q webmin &>/dev/null; then
    dnf install -y webmin 2>/dev/null || true
fi
if [ -f /etc/webmin/miniserv.conf ]; then
    sed -i 's/^port=.*/port=3001/' /etc/webmin/miniserv.conf
    sed -i 's/^listen=.*/listen=3001/' /etc/webmin/miniserv.conf
    grep -q "referrers_none=" /etc/webmin/miniserv.conf || echo "referrers_none=1" >> /etc/webmin/miniserv.conf
    systemctl daemon-reload
    systemctl enable --now webmin 2>/dev/null || true
    echo "  Webmin Control Panel active on port 3001"
fi

# ──────────────────────────────────────────────
# Step 13 — Set timezone to Africa/Cairo
# ──────────────────────────────────────────────
echo ""
echo "[13/14] Setting timezone to Africa/Cairo..."
timedatectl set-timezone Africa/Cairo 2>/dev/null && echo "  Timezone set to Africa/Cairo" || echo "  Warning: Could not set timezone (timedatectl may not be available)"
if [ -f /etc/php.ini ]; then
    sed -i 's@^;\?date\.timezone =.*@date.timezone = "Africa/Cairo"@' /etc/php.ini
    systemctl restart httpd 2>/dev/null || true
    systemctl restart php-fpm 2>/dev/null || true
    echo "  PHP timezone set to Africa/Cairo in /etc/php.ini"
fi
echo "  Current timezone: $(timedatectl 2>/dev/null | grep 'Time zone' || echo 'N/A')"
# ──────────────────────────────────────────────
# Step 14 — Verify
# ──────────────────────────────────────────────
echo ""
echo "[14/14] Verifying installation..."
sleep 2
echo "--- Sokrat VoIP Service ---"
systemctl status sokrat-voip --no-pager -l | head -12
echo ""
echo "--- Sokrat VOICE Softphone Service ---"
systemctl status sokrat-softphone --no-pager -l | head -12
echo ""
echo "--- Webmin Control Panel Service ---"
systemctl status webmin --no-pager -l 2>/dev/null | head -10 || true
echo ""
echo "============================================"
echo " Installation complete!"
echo " Access Sokrat VOIP Dashboard on: http://<machine_ip>/"
echo " Access Sokrat VOICE Softphone on: https://<machine_ip>/phone/ or https://<machine_ip>:8443/"
echo " Access Webmin Control Panel on: https://<machine_ip>:3001/"
echo "============================================"
