# MicroSIP incoming-call log (employee devices)

One file: [sokrat-call-log-setup.ps1](/opt/sokrat-voip/scripts/microsip/sokrat-call-log-setup.ps1).
It embeds the logger, installs it, wires MicroSIP, self-tests, and uninstalls.

Logs the **Caller ID of every incoming call** received by MicroSIP (the softphone
registered to Sokrat VoIP). MicroSIP has no plugin API, but it runs an external
command on each incoming INVITE — `cmdIncomingCall` in `microsip.ini`
([documented upstream](https://www.microsip.org/help#settings-not-included-in-settings-dialog)) —
which receives the Caller ID as its last argument.

## Install on a device

```powershell
# elevated PowerShell (ProgramData + every MicroSIP profile on the machine)
powershell -NoProfile -ExecutionPolicy Bypass -File sokrat-call-log-setup.ps1
```

Prerequisites:

1. MicroSIP has been started at least once **by that employee**, so
   `%APPDATA%\MicroSIP\microsip.ini` exists. Otherwise the setup exits 3 and tells you so.
2. MicroSIP is closed. It rewrites `microsip.ini` on exit, so a hook written while it
   runs is lost. Use `-WaitSeconds 300` to wait for the employee to close it, or
   `-RestartMicroSip` to relaunch it afterwards.

What it writes:

* `C:\ProgramData\SokratCallLog\log-caller.ps1` (the logger; UTF-8, no BOM)
* `C:\ProgramData\SokratCallLog\calls.log` (created on the first incoming call)
* in `[Settings]` of every existing `microsip.ini` on the machine:

```ini
cmdIncomingCall=C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File C:\ProgramData\SokratCallLog\log-caller.ps1
```

* a timestamped backup next to each patched ini (`microsip.ini.bak-<yyyyMMddHHmmss>`)
* `icacls` **Modify** for builtin Users (`*S-1-5-32-545`, locale-independent) on the
  install folder, so any employee logging in can append to the shared log

## Where the log is

```
C:\ProgramData\SokratCallLog\calls.log
```

One file per device, shared by all Windows users on it. Append errors land in
`calls.log.error.txt` in the same folder.

## Format

UTF-8 without BOM, CRLF line endings, one line per incoming call, three
tab-separated fields, no header:

```
2026-11-25 18:05:31	971501234567	971501234567
2026-11-25 18:05:32	971509998877	"Ahmed Emad" <sip:971509998877@13.140.209.230>
2026-11-25 18:05:35		anonymous
```

| # | Field | Content |
| --- | --- | --- |
| 1 | timestamp | local machine time, `yyyy-MM-dd HH:mm:ss` |
| 2 | caller number | digits of the Caller ID, leading `+` kept; empty when the Caller ID had no digits |
| 3 | raw Caller ID | as MicroSIP received it, CR/LF/tab collapsed to spaces, max 200 chars |

Only incoming calls are logged; `cmdIncomingCall` never fires for outgoing calls.
MicroSIP allows a single active SIP account, so a logged call is by construction a
call received on the Sokrat registration.

Reading it on a device:

```powershell
Get-Content C:\ProgramData\SokratCallLog\calls.log -Tail 20
```

## Uninstall

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File sokrat-call-log-setup.ps1 -Uninstall
```

Removes `cmdIncomingCall` from every profile (only when it points at
`log-caller.ps1`/`SokratCallLog`; a foreign value is left alone and reported) and
deletes the installed logger. `calls.log` is kept. Restart MicroSIP afterwards.

## Options

| Switch | Effect |
| --- | --- |
| `-InstallDir <path>` | install elsewhere (default `%ProgramData%\SokratCallLog`) |
| `-IniPath <file[,file]>` | patch explicit ini files instead of discovering profiles |
| `-CurrentUserOnly` | only the invoking user's `%APPDATA%\MicroSIP\microsip.ini` |
| `-Quiet` | no informational output (RMM friendly) |
| `-WaitSeconds <n>` | wait up to n seconds for MicroSIP to exit before patching |
| `-RestartMicroSip` | relaunch MicroSIP after a successful install |
| `-NoSelfTest` | skip the logger append self-test |
| `-SkipAcl` | do not grant Users Modify on the install folder |
| `-Uninstall` | remove hook and logger |

Exit codes: `0` ok, `2` MicroSIP running, `3` no MicroSIP profile found, `4` ini
patch failed, `5` self-test failed, `6` not elevated.

## Mass deployment notes

* Idempotent: safe to run at every boot/logon; re-running rewrites the same line.
* Run as SYSTEM/administrator (Intune, SCCM, PDQ, GPO startup script):
  `powershell.exe -NoProfile -ExecutionPolicy Bypass -File <path>\sokrat-call-log-setup.ps1 -Quiet`
* A device whose employee has never launched MicroSIP exits 3; schedule a rerun.
* Per-user install without elevation:
  `-InstallDir "$env:LOCALAPPDATA\SokratCallLog" -CurrentUserOnly`.
* Cost per call: one hidden `powershell.exe` (~150-300 ms, ~40 MB peak). No console
  window, no audio-path involvement, no effect on the call itself.
* Paths in the hook must be space-free: MicroSIP strips quotes and launches the value
  with `WinExec`. The setup applies 8.3 short paths to any path that contains a space.
