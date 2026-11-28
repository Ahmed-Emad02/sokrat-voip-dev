# Windows VM test brief — Sokrat incoming-caller log for MicroSIP

Self-contained brief for an AI agent running **on a Windows machine with MicroSIP
installed** (the test VM or an employee device). Generated from
`sokrat-call-log-setup.ps1`; if that file is reachable, use it instead of retyping the
block at the end.

Goal: prove that a real incoming call to the MicroSIP softphone registered to Sokrat
VoIP appends the **caller number** to `C:\ProgramData\SokratCallLog\calls.log`.

## Ground rules

- Touch only this Windows machine. Do not change the Sokrat PBX/gateway, SIP accounts,
  dialplans, codecs, or network/tunnel configuration.
- Do not uninstall, upgrade, or reconfigure MicroSIP beyond the single
  `cmdIncomingCall` line the setup writes. The setup backs up `microsip.ini` itself.
- Do not reboot the VM. Do not delete `calls.log` evidence before reporting.
- Use Windows PowerShell 5.1 (`powershell.exe`) for the setup, because that is what
  MicroSIP executes later.
- Report only what you observed. If a step cannot be completed, give the exact command,
  its output, and the blocker.

## 0. Inventory (report)

```powershell
$PSVersionTable.PSVersion.ToString()
Get-Process MicroSIP -ErrorAction SilentlyContinue | Select-Object Id,Path,@{n='Ver';e={$_.MainModule.FileVersionInfo.FileVersion}}
Test-Path "$env:APPDATA\MicroSIP\microsip.ini"
Get-ChildItem "$env:APPDATA\MicroSIP" | Select-Object Name,Length,LastWriteTime
Select-String "$env:APPDATA\MicroSIP\microsip.ini" -Pattern '^cmdIncomingCall=' -ErrorAction SilentlyContinue
([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
```

If `microsip.ini` does not exist, start MicroSIP once, close it, and report that this
was needed. If MicroSIP is running, close it from the tray icon (Exit) before step 2.

## 1. Create the setup file

Create `C:\SokratCallLog\sokrat-call-log-setup.ps1` with exactly the content of the
block at the end of this brief. Report `(Get-FileHash ...).Hash` and the file length.

## 2. Run the setup (elevated)

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File C:\SokratCallLog\sokrat-call-log-setup.ps1
```

Expected output (paths, then a passing self-test):

```
logger  : C:\ProgramData\SokratCallLog\log-caller.ps1
acl     : Users = Modify on C:\ProgramData\SokratCallLog
hook    : installed -> C:\Users\<user>\AppData\Roaming\MicroSIP\microsip.ini
log     : C:\ProgramData\SokratCallLog\calls.log
selftest: ok (logger appends as expected)
```

Report the exact output and `$LASTEXITCODE` (expect `0`). If it exits `2`, MicroSIP was
still running: close it and rerun. If it exits `6`, rerun elevated. If `3`, no
`microsip.ini` exists yet. If `5`, report the self-test failure verbatim and stop.

## 3. Verify the installation

```powershell
Select-String 'C:\Users\*\AppData\Roaming\MicroSIP\microsip.ini' -Pattern '^\[Settings\]$','^cmdIncomingCall='
Get-ChildItem C:\ProgramData\SokratCallLog | Select-Object Name,Length
icacls C:\ProgramData\SokratCallLog
$ini = "$env:APPDATA\MicroSIP\microsip.ini"
$backup = (Get-ChildItem "$ini.bak-*" | Sort-Object LastWriteTime | Select-Object -Last 1).FullName
Compare-Object (Get-Content $backup) (Get-Content $ini)
```

Requirements:
- exactly one `cmdIncomingCall=` under `[Settings]`, no spaces in any path,
  `-File C:\ProgramData\SokratCallLog\log-caller.ps1` at the end;
- `Compare-Object` shows exactly one difference (the added line);
- `icacls` output contains `Users:(OI)(CI)(M)` (locale name may differ, the SID
  `S-1-5-32-545` must be present);
- `log-caller.ps1` exists in `C:\ProgramData\SokratCallLog`.

## 4. Unit-test the installed logger

Use a temporary log so the production file only receives the live call later.

```powershell
$env:SOKRAT_CALLS_LOG = "$env:TEMP\sokrat-unit.log"
Remove-Item $env:SOKRAT_CALLS_LOG -ErrorAction SilentlyContinue
$log = 'C:\ProgramData\SokratCallLog\log-caller.ps1'
$exe = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
& $exe -NoProfile -ExecutionPolicy Bypass -File $log 971501234567
& $exe -NoProfile -ExecutionPolicy Bypass -File $log '"Ahmed Emad" <sip:971509998877@13.140.209.230>'
& $exe -NoProfile -ExecutionPolicy Bypass -File $log 'sip:+442071838750@pbx;user=phone'
& $exe -NoProfile -ExecutionPolicy Bypass -File $log 100
"last exit: $LASTEXITCODE"
Get-Content $env:SOKRAT_CALLS_LOG | ForEach-Object { $_ -replace "`t", '<TAB>' }
Test-Path ($env:SOKRAT_CALLS_LOG + '.error.txt')
```

Expected: four lines; number column `971501234567`, `971509998877`,
`+442071838750`, `100`; `last exit: 0`; no `.error.txt`; no console window left open.

Concurrency (must yield 20 lines, 20 distinct numbers, no error file):

```powershell
Remove-Item $env:SOKRAT_CALLS_LOG -ErrorAction SilentlyContinue
$procs = 1..20 | ForEach-Object {
    Start-Process -FilePath $exe -NoNewWindow -PassThru -ArgumentList @(
        '-NoProfile','-ExecutionPolicy','Bypass','-File',$log,"97150000$_")
}
$procs | Wait-Process
(Get-Content $env:SOKRAT_CALLS_LOG).Count
(Get-Content $env:SOKRAT_CALLS_LOG | ForEach-Object { ($_ -split "`t")[1] } | Sort-Object -Unique).Count
Test-Path ($env:SOKRAT_CALLS_LOG + '.error.txt')
Remove-Item Env:SOKRAT_CALLS_LOG
```

A count below 20 means concurrent appends were not serialised — report it verbatim.

## 5. Live incoming call

1. Start MicroSIP, confirm the Sokrat account is registered (green/online indicator).
2. Note `Get-Date` and the current `calls.log` length.
3. Trigger one real incoming call to this extension:
   - ask the operator to dial the extension from another phone, or
   - from a host with PBX access:
     `asterisk -rx "channel originate PJSIP/<endpoint> application Playback demo-congrats"`,
     or
   - from a second SIP client, dial `sip:<extension>@<pbx-ip>`.
4. Read the number MicroSIP shows in its incoming-call window, let it ring ~10 s,
   answer if possible, hang up.
5. ```powershell
   Get-Content C:\ProgramData\SokratCallLog\calls.log -Tail 5 | ForEach-Object { $_ -replace "`t", '<TAB>' }
   Test-Path C:\ProgramData\SokratCallLog\calls.log.error.txt
   ```

Expected: exactly one new line, timestamp after step 2, and the number column **equal
to the caller number MicroSIP displayed** (not the extension that was dialed). No
console window may appear, focus must not leave MicroSIP, and the call must ring,
answer, and carry audio normally.

## 6. Negative and restart cases

- Place an **outgoing** call; the `calls.log` line count must not change.
- Restart MicroSIP, repeat one incoming call; it must still log (proves the ini edit
  survives MicroSIP's write-on-exit).
- Optional: two incoming calls back to back; report whether each produced exactly one line.

## 7. Uninstall / reinstall (optional, only if asked)

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File C:\SokratCallLog\sokrat-call-log-setup.ps1 -Uninstall
# expect: removed -> <ini>, removed ...\log-caller.ps1 ; calls.log kept
```

Reinstall with step 2 afterwards so the machine is left in the installed state.

## 8. Report

1. MicroSIP version, ini path, PowerShell version, elevated or not.
2. Full setup output, exit code, the `Hook` line, backup file name.
3. `Compare-Object` diff result and the `icacls` line.
4. All unit-test lines and the concurrency counts.
5. The live-call line, plus the caller number MicroSIP displayed.
6. Outgoing-call and restart results; whether `calls.log.error.txt` exists.
7. Anything that failed, with exact error text; and whether the machine is left installed.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Setup exits 3 | employee never started MicroSIP, so no `microsip.ini` | start MicroSIP once, exit it, rerun |
| Setup exits 2 | MicroSIP still running; it rewrites the ini on exit | exit from tray, or `-WaitSeconds 300` |
| Setup exits 6 | not elevated, default ProgramData install | rerun elevated, or `-InstallDir "$env:LOCALAPPDATA\SokratCallLog" -CurrentUserOnly` |
| Setup exits 5 | logger could not append (permissions, execution policy, AV) | read the printed failure, check `icacls`, try `-ExecutionPolicy Bypass` |
| Hook present, no line on a real call | MicroSIP not restarted after install | exit MicroSIP fully, start again |
| Hook present, nothing logged, path fine | MicroSIP stripped quotes / mismatched path | run the `Hook` value by hand in `cmd.exe` with a test number |
| Unit test writes, live call does not | hook not in `[Settings]`, or the employee's profile was not the one patched | check with `Select-String` across `C:\Users\*\...\microsip.ini`; rerun `-WaitSeconds` after MicroSIP exits |
| Lines missing under load | concurrent append not serialised | report; the logger opens with `FileShare.Read` and retries 60x50 ms |

## File

### sokrat-call-log-setup.ps1

```powershell
#Requires -Version 5.1
<#
    sokrat-call-log-setup.ps1 - one-file installer.
    Logs the Caller ID of every incoming MicroSIP call to a single calls.log.

    Installs into %ProgramData%\SokratCallLog (all users on the device share one
    log) and writes the MicroSIP hook

        [Settings] cmdIncomingCall=...powershell.exe ... -File ...\log-caller.ps1

    into every existing MicroSIP profile on the machine. The logger itself is
    embedded in this file, so this file is the only thing to copy to a device.

    Usage:
        powershell -NoProfile -ExecutionPolicy Bypass -File sokrat-call-log-setup.ps1
        powershell ... -File sokrat-call-log-setup.ps1 -WaitSeconds 600 -Quiet
        powershell ... -File sokrat-call-log-setup.ps1 -CurrentUserOnly
        powershell ... -File sokrat-call-log-setup.ps1 -Uninstall

    Exit codes: 0 ok, 2 MicroSIP still running, 3 no MicroSIP profile found,
                4 could not patch the ini, 5 self-test failed, 6 not elevated.
#>
[CmdletBinding()]
param(
    [string]$InstallDir = (Join-Path $env:ProgramData 'SokratCallLog'),
    [string[]]$IniPath,
    [switch]$CurrentUserOnly,
    [switch]$Uninstall,
    [switch]$Quiet,
    [int]$WaitSeconds = 0,
    [switch]$RestartMicroSip,
    [switch]$NoSelfTest,
    [switch]$SkipAcl
)

$ErrorActionPreference = 'Stop'

$LoggerFileName = 'log-caller.ps1'
$LogFileName = 'calls.log'
$KeyName = 'cmdIncomingCall'
$HookMarker = 'SokratCallLog'

function Say {
    param([string]$Message)
    if (-not $Quiet) { Write-Host $Message }
}

function Fail {
    param([string]$Message, [int]$Code)
    Write-Error $Message -ErrorAction Continue
    exit $Code
}

function Get-ShortPathName {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not ('Sokrat.SetupIni' -as [type])) {
        Add-Type -Namespace 'Sokrat' -Name 'SetupIni' -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("kernel32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode, SetLastError = true)]
public static extern uint GetShortPathNameW(string lpszLongPath, System.Text.StringBuilder lpszShortPath, uint cchBuffer);
'@
    }

    $buffer = New-Object System.Text.StringBuilder 1024
    $length = [Sokrat.SetupIni]::GetShortPathNameW($Path, $buffer, 1024)
    if ($length -gt 0) { return $buffer.ToString() }
    return $Path
}

function Get-CommandPath {
    param([Parameter(Mandatory = $true)][string]$Path)

    # MicroSIP strips quotes and launches the value with WinExec, so every path in
    # the command must be space-free.
    if ($Path -match '\s') {
        $short = Get-ShortPathName -Path $Path
        if ($short -match '\s') {
            throw "Path contains spaces and has no 8.3 alias: $Path"
        }
        return $short
    }
    return $Path
}

function Read-IniContent {
    param([Parameter(Mandatory = $true)][string]$Path)

    # microsip.ini is written ANSI by MicroSIP; a UTF-8 file must survive the edit
    # byte for byte, so the encoding is taken from the content.
    $bytes = [System.IO.File]::ReadAllBytes($Path)
    $hasBom = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
    $offset = 0
    $encoding = [System.Text.Encoding]::Default

    if ($hasBom) {
        $offset = 3
        $encoding = New-Object System.Text.UTF8Encoding -ArgumentList $true
    }
    else {
        try {
            $strictUtf8 = New-Object System.Text.UTF8Encoding -ArgumentList $false, $true
            $null = $strictUtf8.GetString($bytes)
            $encoding = $strictUtf8
        }
        catch {
            $encoding = [System.Text.Encoding]::Default
        }
    }

    $text = $encoding.GetString($bytes, $offset, $bytes.Length - $offset)
    $lines = New-Object System.Collections.Generic.List[string]
    foreach ($line in ($text -split "`r`n|`n|`r")) { $lines.Add($line) }
    if ($lines.Count -gt 0 -and $lines[$lines.Count - 1] -eq '') {
        $lines.RemoveAt($lines.Count - 1)
    }

    return [pscustomobject]@{ Lines = $lines; Encoding = $encoding; HasBom = $hasBom }
}

function Write-IniContent {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)]$Content
    )

    $body = ($Content.Lines -join "`r`n") + "`r`n"
    $payload = $Content.Encoding.GetBytes($body)

    if ($Content.HasBom) {
        $preamble = $Content.Encoding.GetPreamble()
        $bytes = New-Object byte[] ($preamble.Length + $payload.Length)
        [System.Array]::Copy($preamble, 0, $bytes, 0, $preamble.Length)
        [System.Array]::Copy($payload, 0, $bytes, $preamble.Length, $payload.Length)
        [System.IO.File]::WriteAllBytes($Path, $bytes)
    }
    else {
        [System.IO.File]::WriteAllBytes($Path, $payload)
    }
}

function Get-MicroSipIniPaths {
    $found = New-Object System.Collections.Generic.List[string]

    if ($env:APPDATA) {
        $current = Join-Path $env:APPDATA 'MicroSIP\microsip.ini'
        if (Test-Path -LiteralPath $current) { $found.Add($current) }
    }

    if (-not $CurrentUserOnly -and $env:SystemDrive) {
        $usersRoot = Join-Path $env:SystemDrive 'Users'
        if (Test-Path -LiteralPath $usersRoot) {
            foreach ($profile in (Get-ChildItem -LiteralPath $usersRoot -Directory -ErrorAction SilentlyContinue)) {
                $candidate = Join-Path $profile.FullName 'AppData\Roaming\MicroSIP\microsip.ini'
                if (Test-Path -LiteralPath $candidate) { $found.Add($candidate) }
            }
        }
    }

    return $found | Select-Object -Unique
}

function Set-IniHook {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [string]$CommandValue
    )

    $ini = Read-IniContent -Path $Path
    $lines = $ini.Lines

    $settingsStart = -1
    $settingsEnd = $lines.Count
    for ($i = 0; $i -lt $lines.Count; $i++) {
        $trimmed = $lines[$i].Trim()
        if ($trimmed -match '^\[(.+)\]$') {
            if ($settingsStart -ge 0 -and $settingsEnd -eq $lines.Count -and $i -gt $settingsStart) {
                $settingsEnd = $i
            }
            if ($settingsStart -lt 0 -and $matches[1].Trim() -ieq 'Settings') {
                $settingsStart = $i
            }
        }
    }

    if ($settingsStart -lt 0) {
        $lines.Add('[Settings]')
        $settingsStart = $lines.Count - 1
        $settingsEnd = $lines.Count
    }

    $existingIndex = -1
    for ($i = $settingsStart + 1; $i -lt $settingsEnd; $i++) {
        if ($lines[$i].Trim() -match ('^' + [regex]::Escape($KeyName) + '\s*=')) {
            $existingIndex = $i
            break
        }
    }

    if (-not $CommandValue) {
        if ($existingIndex -lt 0) { return 'absent' }
        $current = $lines[$existingIndex]
        if ($current -notmatch [regex]::Escape($HookMarker) -and
            $current -notmatch [regex]::Escape($LoggerFileName)) {
            return 'foreign'
        }
        $lines.RemoveAt($existingIndex)
    }
    elseif ($existingIndex -ge 0) {
        $lines[$existingIndex] = $KeyName + '=' + $CommandValue
    }
    else {
        $lines.Insert($settingsStart + 1, $KeyName + '=' + $CommandValue)
    }

    $backup = '{0}.bak-{1}' -f $Path, (Get-Date -Format 'yyyyMMddHHmmss')
    Copy-Item -LiteralPath $Path -Destination $backup -Force
    Write-IniContent -Path $Path -Content $ini

    if (-not $CommandValue) { return 'removed' }
    return 'installed'
}

# ---- embedded logger --------------------------------------------------------

$LoggerSource = @'
#Requires -Version 5.1
<#
    log-caller.ps1 - append the Caller ID of an incoming MicroSIP call to calls.log.
    Installed and wired by sokrat-call-log-setup.ps1; do not edit by hand.

    MicroSIP appends the Caller ID as the last command-line argument, so this file
    takes no declared parameters: everything is read from $args, which tolerates a
    display name with spaces splitting into several tokens, or a quoted SIP URI.

    Output: one tab-separated line per incoming call, appended to calls.log:
        <yyyy-MM-dd HH:mm:ss> <TAB> <number> <TAB> <raw caller id>

    The number column is the digits of the Caller ID (a leading + is kept); it is
    empty when the Caller ID carried no digits, and the raw column keeps the
    original text. Errors are written to calls.log.error.txt; this script always
    exits 0 so it can never disturb the softphone.
#>

$ErrorActionPreference = 'Stop'

$logPath = Join-Path -Path $PSScriptRoot -ChildPath 'calls.log'
if ($env:SOKRAT_CALLS_LOG -and $env:SOKRAT_CALLS_LOG.Trim()) {
    $logPath = $env:SOKRAT_CALLS_LOG.Trim()
}
$errorPath = $logPath + '.error.txt'

function Write-Append {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Text
    )

    $dir = Split-Path -Parent $Path
    if ($dir -and -not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }

    $encoding = New-Object System.Text.UTF8Encoding($false)
    $bytes = $encoding.GetBytes($Text + "`r`n")

    # Several incoming calls can spawn concurrent instances, and FileStream append
    # seeks to the end before writing, so two writers can clobber one line. Deny
    # other writers (FileShare.Read) and retry until the file is free.
    for ($attempt = 0; $attempt -lt 60; $attempt++) {
        try {
            $stream = [System.IO.FileStream]::new(
                $Path,
                [System.IO.FileMode]::Append,
                [System.IO.FileAccess]::Write,
                [System.IO.FileShare]::Read)
            try {
                $stream.Write($bytes, 0, $bytes.Length)
                $stream.Flush()
            }
            finally {
                $stream.Dispose()
            }
            return
        }
        catch {
            if ($attempt -eq 59) { throw }
            Start-Sleep -Milliseconds 50
        }
    }
}

function Get-CallerNumber {
    param([string]$Raw)

    $number = ''

    # "Display Name" <sip:971501234567@host> / sip:971501234567@host
    $sip = [regex]::Match($Raw, '(?i)\bsips?:\s*([^@;>\s,]+)')
    if ($sip.Success) {
        $number = $sip.Groups[1].Value
    }

    if (-not $number) {
        # Longest phone-like run: digits with the usual separators.
        $candidate = [regex]::Match($Raw, '\+\d[\d\s\-\(\)\.]{1,30}\d|\d[\d\s\-\(\)\.]{2,30}\d|\d{2,}')
        if ($candidate.Success) {
            $number = $candidate.Value
        }
    }

    if ($number) {
        $plus = ''
        if ($number.TrimStart().StartsWith('+')) { $plus = '+' }
        $digits = ($number -replace '\D', '')
        if ($digits) { $number = $plus + $digits } else { $number = '' }
    }

    return $number
}

try {
    $raw = ($args -join ' ').Trim()
    if (-not $raw) { $raw = '(none)' }

    # Keep the log single-line and bounded, whatever the peer sends.
    $rawClean = $raw -replace '\s+', ' '
    $rawClean = $rawClean -replace '[\x00-\x1F\x7F]', ''
    $rawClean = $rawClean.Trim()
    if ($rawClean.Length -gt 200) { $rawClean = $rawClean.Substring(0, 200) }

    # MicroSIP appends the Caller ID as one argument; take the first argument that
    # carries a real number so a display name split on spaces cannot merge digits
    # across tokens, then fall back to the whole line.
    $number = ''
    foreach ($part in $args) {
        $candidate = Get-CallerNumber -Raw $part
        if ($candidate -and (($candidate -replace '\D', '').Length -ge 3)) {
            $number = $candidate
            break
        }
    }
    if (-not $number) { $number = Get-CallerNumber -Raw $rawClean }

    $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    $line = $stamp + "`t" + $number + "`t" + $rawClean

    Write-Append -Path $logPath -Text $line
}
catch {
    try {
        $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
        Write-Append -Path $errorPath -Text ($stamp + "`t" + $_.Exception.Message)
    }
    catch {
        # Nothing left to do; never interrupt the softphone.
    }
}

exit 0
'@

# ---- elevation --------------------------------------------------------------

if (-not $Uninstall) {
    $isAdmin = $true
    try {
        $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
            [Security.Principal.WindowsBuiltInRole]::Administrator)
    }
    catch {
        # Non-Windows host (script logic tests); elevation is not applicable there.
        $isAdmin = $true
    }

    if (-not $isAdmin -and $InstallDir -like '*\ProgramData\*') {
        Fail ('This installs into ProgramData and patches every MicroSIP profile, so it needs an ' +
              'elevated PowerShell. Re-run as Administrator, or use -InstallDir ' +
              '"$env:LOCALAPPDATA\SokratCallLog" -CurrentUserOnly for a per-user install.') 6
    }
}

# ---- uninstall --------------------------------------------------------------

if ($Uninstall) {
    $targets = @()
    if ($IniPath) { $targets = $IniPath }
    else { $targets = @(Get-MicroSipIniPaths) }

    if (-not $targets) {
        Fail 'No MicroSIP profile (microsip.ini) found; nothing to remove.' 3
    }

    foreach ($path in $targets) {
        if (-not (Test-Path -LiteralPath $path)) { continue }
        $result = Set-IniHook -Path $path -CommandValue ''
        Say ("[{0}] {1}" -f $result, $path)
        if ($result -eq 'foreign') {
            Say "  kept: cmdIncomingCall points outside $HookMarker (not ours)"
        }
    }

    $loggerPath = Join-Path $InstallDir $LoggerFileName
    if (Test-Path -LiteralPath $loggerPath) {
        Remove-Item -LiteralPath $loggerPath -Force
        Say "removed $loggerPath"
    }
    Say 'Uninstalled. Existing calls.log files were kept.'
    Say 'Start MicroSIP again for the removed hook to take effect.'
    exit 0
}

# ---- pre-flight -------------------------------------------------------------

if ($IniPath) {
    $targets = @($IniPath | Where-Object { $_ })
    foreach ($path in $targets) {
        if (-not (Test-Path -LiteralPath $path)) {
            Fail "microsip.ini not found: $path" 3
        }
    }
}
else {
    if (-not $env:APPDATA) { Fail 'APPDATA is not set; pass -IniPath explicitly.' 3 }
    $targets = @(Get-MicroSipIniPaths)
    if (-not $targets) {
        Fail ('No MicroSIP profile found. Start MicroSIP once on this device (so it creates ' +
              '%APPDATA%\MicroSIP\microsip.ini), then run this setup again.') 3
    }
}

$process = Get-Process -Name 'MicroSIP' -ErrorAction SilentlyContinue | Select-Object -First 1
if ($process) {
    if ($WaitSeconds -gt 0) {
        Say "MicroSIP is running (pid $($process.Id)); waiting up to $WaitSeconds s for it to exit."
        Say 'Close it from the tray icon now: it rewrites microsip.ini on exit.'
        $deadline = (Get-Date).AddSeconds($WaitSeconds)
        while ((Get-Date) -lt $deadline) {
            Start-Sleep -Seconds 2
            if (-not (Get-Process -Id $process.Id -ErrorAction SilentlyContinue)) { break }
        }
    }
    if (Get-Process -Name 'MicroSIP' -ErrorAction SilentlyContinue) {
        Fail ('MicroSIP is still running. Exit it completely (tray icon -> Exit) and rerun, ' +
              'or pass -WaitSeconds 300. Editing the ini while it runs is lost on its exit.') 2
    }
}

# ---- install ----------------------------------------------------------------

if (-not (Test-Path -LiteralPath $InstallDir)) {
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
}

$loggerPath = Join-Path $InstallDir $LoggerFileName
$normalized = ($LoggerSource -replace "`r`n", "`n") -replace "`n", "`r`n"
[System.IO.File]::WriteAllText($loggerPath, $normalized, (New-Object System.Text.UTF8Encoding -ArgumentList $false))
Say "logger  : $loggerPath"

if (-not $SkipAcl -and $env:SystemRoot -and (Test-Path (Join-Path $env:SystemRoot 'System32\icacls.exe'))) {
    # Builtin Users (SID, so it works on any locale) needs Modify on the shared log.
    $aclArgs = @($InstallDir, '/grant', '*S-1-5-32-545:(OI)(CI)M', '/T', '/C')
    $acl = & (Join-Path $env:SystemRoot 'System32\icacls.exe') @aclArgs 2>&1
    if ($LASTEXITCODE -ne 0) {
        Say "warning : icacls failed; employees may not be able to append to $LogFileName"
        Say ("          $acl")
    }
    else {
        Say "acl     : Users = Modify on $InstallDir"
    }
}

$powerShellExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
try {
    $exeArg = Get-CommandPath -Path $powerShellExe
    $scriptArg = Get-CommandPath -Path $loggerPath
}
catch {
    Fail $_.Exception.Message 4
}
$commandValue = '{0} -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File {1}' -f $exeArg, $scriptArg

$failed = 0
foreach ($path in $targets) {
    try {
        $result = Set-IniHook -Path $path -CommandValue $commandValue
        Say ("hook    : {0} -> {1}" -f $result, $path)
    }
    catch {
        Write-Error ("failed to patch {0}: {1}" -f $path, $_.Exception.Message) -ErrorAction Continue
        $failed++
    }
}
if ($failed -gt 0) { Fail "$failed MicroSIP profile(s) could not be patched." 4 }

$hookOk = $true
foreach ($path in $targets) {
    $verify = Select-String -LiteralPath $path -Pattern ('^' + [regex]::Escape($KeyName) + '=')
    if (-not $verify) { $hookOk = $false }
}
if (-not $hookOk) { Fail 'cmdIncomingCall missing after patching.' 4 }

Say "log     : $(Join-Path $InstallDir $LogFileName)"

# ---- self-test --------------------------------------------------------------

if (-not $NoSelfTest) {
    $tempLog = Join-Path ([System.IO.Path]::GetTempPath()) ('sokrat-selftest-' + [guid]::NewGuid().ToString('n') + '.log')
    $hostExe = (Get-Process -Id $PID).Path
    $env:SOKRAT_CALLS_LOG = $tempLog
    try {
        & $hostExe -NoProfile -ExecutionPolicy Bypass -File $loggerPath '971500000000' | Out-Null
        $lastExit = $LASTEXITCODE
        $line = ''
        if (Test-Path -LiteralPath $tempLog) { $line = (Get-Content -LiteralPath $tempLog -TotalCount 1) }
        $ok = ($lastExit -eq 0) -and $line -and (($line -split "`t")[1] -eq '971500000000')
        if ($ok) { Say 'selftest: ok (logger appends as expected)' }
        else {
            Say "selftest: FAILED (exit $lastExit, line '$line')"
            Fail 'Logger self-test failed; hook installed but calls would not be logged.' 5
        }
    }
    finally {
        Remove-Item Env:SOKRAT_CALLS_LOG -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $tempLog -Force -ErrorAction SilentlyContinue
    }
}

Say ''
Say 'Installed. Start MicroSIP; each incoming call appends one line to:'
Say "  $(Join-Path $InstallDir $LogFileName)"

if ($RestartMicroSip) {
    $exe = $null
    if ($process) { $exe = $process.Path }
    if (-not $exe) {
        $installed = @(
            (Join-Path $env:ProgramFiles 'MicroSIP\microsip.exe'),
            (Join-Path ${env:ProgramFiles(x86)} 'MicroSIP\microsip.exe')
        ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
        $exe = $installed
    }
    if ($exe -and (Test-Path -LiteralPath $exe)) {
        Start-Process -FilePath $exe | Out-Null
        Say "restarted MicroSIP: $exe"
    }
    else {
        Say 'MicroSIP executable not found; start it manually.'
    }
}

exit 0
```
