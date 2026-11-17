# Dongle autoconfiguration

Port-based dongle discovery and `dongle.conf` reconciliation for Huawei
modems managed by `chan_dongle`.

## Why

`/dev/ttyUSB*` numbers are assigned in enumeration order and move when a USB
device re-enumerates. `by-id` is not usable for the fleet's Huawei modems
because they report the same `ID_SERIAL` (`HUAWEI_HUAWEI_Mobile`) and their
links collide. The stable identity is the physical USB port.

This tool maps a physical USB port to a logical `dongleN`, discovers the
audio/data interfaces from udev and the model table, and writes
`/dev/serial/by-path/...` paths into `dongle.conf`.

## Files

- `scripts/dongle-autoconfig.py` — CLI launcher.
- `scripts/dongle_autoconfig/` — discovery, classification, config editor,
  apply/rollback, watchdog.
- `/etc/sokrat/dongle-slots.json` — human-owned slot map (not auto-created).
- `/var/lib/sokrat/dongle-autoconfig/backups/` — pre-apply backups.
- `/etc/sokrat/dongle-autoconfig.disabled` — rollback/disable flag.
- `sokrat-dongle-autoconfig.timer` — runs reconciliation every 60 seconds.

## Bootstrap safely

Run from the repository checkout:

```bash
sudo python3 scripts/dongle-autoconfig.py inventory
sudo python3 scripts/dongle-autoconfig.py bootstrap --json
```

Review the proposed slot map. Write it only when it matches the physical
port layout:

```bash
sudo python3 scripts/dongle-autoconfig.py bootstrap --write
```

Existing `dongle.conf` sections are matched by their real tty targets. A
stale section with no present hardware is not added to the map.

## Plan and apply

Default is read-only:

```bash
sudo python3 scripts/dongle-autoconfig.py plan
sudo python3 scripts/dongle-autoconfig.py plan --json
```

Apply is explicit and idle-gated:

```bash
sudo python3 scripts/dongle-autoconfig.py apply --yes
```

`apply` refuses when `core show channels count` reports active calls. It
backs up `dongle.conf`, writes atomically, reloads `chan_dongle.so`, waits,
and validates every changed dongle's `State` and `IMSI`. On failure it
restores the exact previous file and reloads again.

## Enable the timer

From the checkout you want to test:

```bash
sudo bash scripts/install-dongle-autoconfig.sh --repo "$PWD"
```

The helper substitutes the checkout path into the service unit, installs the
timer, and enables it only when `/etc/sokrat/dongle-slots.json` exists.

If `/etc/sokrat/dongle-slots.json` is absent, the service is a no-op.

## Health recovery

`reconcile --auto` also runs the watchdog. If a dongle is `Not connected`,
`Unknown`, or has an empty IMSI for more than two minutes, and it has no
active calls, it queues `dongle reset` (which sends `AT+CFUN=1,1`). A
cooldown and a per-hour retry limit prevent a reset loop. The by-path links
make the modem re-enumeration safe.

## Rollback

The UI button is under **Configuration → Modem Conf → Dongle Slot
Management → Rollback Autoconfig**. It is root-only.

It restores the permanent `pre-autoconfig.bak` from the autoconfig backup
directory, reloads `chan_dongle.so`, and writes the disable flag so the
timer cannot immediately re-apply the new layout.

CLI equivalent:

```bash
sudo python3 scripts/dongle-autoconfig.py status
sudo python3 scripts/dongle-autoconfig.py rollback --yes
```

To re-enable autoconfiguration after a rollback, remove the flag and run a
fresh plan:

```bash
sudo rm -f /etc/sokrat/dongle-autoconfig.disabled
sudo python3 scripts/dongle-autoconfig.py plan
```

## Tests

```bash
cd /opt/sokrat-voip-dongle-autoconfig
python3 -m unittest discover -s test/dongle_autoconfig -p 'test_*.py'
node --test test/dongle-autoconfig.test.js
```

The tests use temporary directories and fake udev/Asterisk output; they do
not touch `/etc/asterisk` or reload Asterisk.

## Safety model

- Never writes without `--yes`.
- Never reloads with active calls unless `--force` is given.
- Preserves all unrelated `dongle.conf` lines and comments.
- Preserves file owner/mode on atomic replace.
- Keeps 20 backups.
- Fails closed on unknown models: set `audio_interface` and
  `data_interface` explicitly in the slot map.
- Rollback disables the timer's reconciliation path.
