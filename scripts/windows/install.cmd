@echo off
rem GMS installer and updater for Windows. Double-click it.
rem
rem First run: installs Node.js and Git if missing, downloads GMS to C:\gms
rem (or the folder in GMSINSTALL_DIR),
rem builds it, creates the database with the city and service lists, and puts
rem "GMS Dashboard" and "Update GMS" shortcuts on the desktop.
rem Every later run: updates to the latest version. Your data is kept.
rem
rem The work is done by the PowerShell below the marker line. This header only
rem starts it, so the installer stays one file you can copy onto a server.
setlocal
rem Deliberately not GMS_*: gms reads every GMS_ variable as a setting.
set "GMSINSTALL_SELF=%~f0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$s = [IO.File]::ReadAllText($env:GMSINSTALL_SELF); $i = $s.IndexOf('##' + 'PS1##'); Invoke-Expression $s.Substring($i)"
set "CODE=%ERRORLEVEL%"
echo.
pause
exit /b %CODE%
##PS1##
# Everything from here on is PowerShell, written for Windows PowerShell 5.1 -
# the version every Windows Server ships with - so no ?? or ternaries.

$ErrorActionPreference = 'Stop'
# Invoke-WebRequest on 5.1 is many times slower while drawing a progress bar.
$ProgressPreference = 'SilentlyContinue'
# 5.1 can default to TLS 1.0, which nodejs.org and GitHub refuse.
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$Repo        = 'https://github.com/ihonore/Orkestra.git'
# Our own variables are named GMSINSTALL_*, never GMS_*: gms reads every GMS_
# variable as a config key and refuses to start on one it does not know - an
# earlier name for the one below stopped the first install at
# "Unrecognized key: self". Read once and removed, so nothing started from
# here inherits them.
$Self        = $env:GMSINSTALL_SELF
$InstallDir  = 'C:\gms'
if ($env:GMSINSTALL_DIR) { $InstallDir = $env:GMSINSTALL_DIR }
Remove-Item Env:GMSINSTALL_SELF -ErrorAction SilentlyContinue
$NodeMajor   = 24
$NodeMinimum = [version]'24.13.0'
$Arch = 'x64'
if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { $Arch = 'arm64' }

function Step([string]$text) {
  Write-Host ''
  Write-Host "==> $text" -ForegroundColor Cyan
}

function Fail([string]$text) {
  Write-Host ''
  Write-Host "Stopped: $text" -ForegroundColor Red
  exit 1
}

# Run a program and stop if it fails. PowerShell does not stop on a native
# command's exit code by itself, so without this a failed npm ci would carry on.
function Invoke-Native([string]$exe, [string[]]$arguments) {
  & $exe @arguments
  if ($LASTEXITCODE -ne 0) { Fail "'$exe $($arguments -join ' ')' failed (exit code $LASTEXITCODE)." }
}

# An installer changes PATH for new processes only; this session needs it too.
function Update-SessionPath {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
              [Environment]::GetEnvironmentVariable('Path', 'User')
}

function Get-NodeVersion {
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) { return $null }
  try { return [version]((& node --version).Trim().TrimStart('v')) } catch { return $null }
}

function Test-Admin {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  return (New-Object Security.Principal.WindowsPrincipal($identity)).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
}

# Download a file and refuse it unless its SHA-256 matches.
function Get-VerifiedFile([string]$url, [string]$expectedSha256, [string]$name) {
  $file = Join-Path $env:TEMP $name
  Invoke-WebRequest -Uri $url -OutFile $file -UseBasicParsing
  $actual = (Get-FileHash -Path $file -Algorithm SHA256).Hash
  if ($expectedSha256 -and ($actual -ne $expectedSha256.ToUpper())) {
    Remove-Item $file -Force
    Fail "the download of $name did not match its published checksum. Try again later."
  }
  return $file
}

Write-Host 'GMS installer' -ForegroundColor White
Write-Host "Install folder: $InstallDir"

# -- What is missing ----------------------------------------------------------
Update-SessionPath
$nodeVersion = Get-NodeVersion
$needNode = ($null -eq $nodeVersion) -or ($nodeVersion -lt $NodeMinimum)
$needGit  = -not (Get-Command git -ErrorAction SilentlyContinue)

# Administrator rights are only needed to install Node.js or Git. An update of
# an existing install runs as you, with no prompt.
if (($needNode -or $needGit) -and -not (Test-Admin)) {
  Write-Host ''
  Write-Host 'Node.js or Git needs installing, which requires administrator rights.'
  Write-Host 'Approve the prompt; the installer continues in a new window.'
  Start-Process -FilePath $Self -Verb RunAs
  exit 0
}

# -- Node.js ------------------------------------------------------------------
if ($needNode) {
  if ($null -eq $nodeVersion) { Step "Installing Node.js $NodeMajor" }
  else { Step "Upgrading Node.js $nodeVersion to $NodeMajor (GMS needs $NodeMinimum or newer)" }

  # index.json lists releases newest first. Assigned before piping: on 5.1,
  # Invoke-RestMethod emits a JSON array as ONE object, so piping it directly
  # would hand Where-Object the whole list at once.
  $releases = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json' -UseBasicParsing
  $release = $releases | Where-Object { $_.version -like "v$NodeMajor.*" } | Select-Object -First 1
  if (-not $release) { Fail "could not find a Node.js $NodeMajor release on nodejs.org." }

  $version = $release.version
  $msiName = "node-$version-$Arch.msi"
  $sums = [string](Invoke-RestMethod -Uri "https://nodejs.org/dist/$version/SHASUMS256.txt" -UseBasicParsing)
  $line = ($sums -split "`n") | Where-Object { $_ -match ([regex]::Escape($msiName) + '\s*$') } | Select-Object -First 1
  if (-not $line) { Fail "nodejs.org publishes no checksum for $msiName." }
  $msi = Get-VerifiedFile "https://nodejs.org/dist/$version/$msiName" ($line -split '\s+')[0] $msiName

  $process = Start-Process -FilePath 'msiexec.exe' -ArgumentList '/i', "`"$msi`"", '/qn', '/norestart' -Wait -PassThru
  # 3010 means "installed, restart recommended", which Node does not need.
  if ($process.ExitCode -ne 0 -and $process.ExitCode -ne 3010) {
    Fail "the Node.js installer failed (exit code $($process.ExitCode))."
  }
  Update-SessionPath
  if ((Get-NodeVersion) -lt $NodeMinimum) { Fail 'Node.js installed, but this window cannot find it. Run the installer again.' }
}
Write-Host "Node.js $(Get-NodeVersion)"

# -- Git ----------------------------------------------------------------------
if ($needGit) {
  Step 'Installing Git'
  $release = Invoke-RestMethod -Uri 'https://api.github.com/repos/git-for-windows/git/releases/latest' `
    -Headers @{ 'User-Agent' = 'gms-installer' } -UseBasicParsing
  $pattern = '^Git-[\d.]+-64-bit\.exe$'
  if ($Arch -eq 'arm64') { $pattern = '^Git-[\d.]+-arm64\.exe$' }
  $asset = $release.assets | Where-Object { $_.name -match $pattern } | Select-Object -First 1
  if (-not $asset) { Fail 'could not find the Git for Windows installer on GitHub.' }

  # GitHub publishes each asset's digest as "sha256:<hex>".
  $sha = $null
  if ($asset.digest -and $asset.digest.StartsWith('sha256:')) { $sha = $asset.digest.Substring(7) }
  $exe = Get-VerifiedFile $asset.browser_download_url $sha $asset.name

  $process = Start-Process -FilePath $exe -ArgumentList '/VERYSILENT', '/NORESTART', '/NOCANCEL', '/SP-', '/SUPPRESSMSGBOXES' -Wait -PassThru
  if ($process.ExitCode -ne 0) { Fail "the Git installer failed (exit code $($process.ExitCode))." }
  Update-SessionPath
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Fail 'Git installed, but this window cannot find it. Run the installer again.' }
}

# -- Refuse to update under a running copy -----------------------------------
# npm cannot replace the database driver while a running process has it loaded.
$running = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
  Where-Object { $_.CommandLine -and $_.CommandLine.ToLower().Contains($InstallDir.ToLower()) }
if ($running) {
  Fail 'GMS is running. Stop any scrape in the dashboard, close the "GMS dashboard" window, then run this again.'
}

# -- The code -----------------------------------------------------------------
$fresh = -not (Test-Path (Join-Path $InstallDir '.git'))
if ($fresh) {
  if ((Test-Path $InstallDir) -and (Get-ChildItem -Path $InstallDir -Force | Select-Object -First 1)) {
    Fail "$InstallDir already exists and is not a GMS install. Move it aside, or set GMSINSTALL_DIR to another folder."
  }
  Step 'Downloading GMS'
  Write-Host 'The repository is private: a GitHub sign-in window may open. Sign in once; Git remembers it.'
  Invoke-Native 'git' @('clone', $Repo, $InstallDir)

  # Created with administrator rights, the folder would be read-only to the
  # same person running the dashboard normally. Give ordinary users write access.
  if (Test-Admin) { Invoke-Native 'icacls.exe' @($InstallDir, '/grant', '*S-1-5-32-545:(OI)(CI)M', '/T', '/Q') }
} else {
  Step 'Downloading the latest version'
  Invoke-Native 'git' @('-C', $InstallDir, 'pull', '--ff-only')
}
Set-Location $InstallDir

# -- Build --------------------------------------------------------------------
Step 'Installing dependencies'
Invoke-Native 'npm.cmd' @('ci', '--no-audit', '--no-fund')

Step 'Installing the browser the scraper drives (Chromium, about 150 MB)'
Invoke-Native 'npx.cmd' @('playwright', 'install', 'chromium')

Step 'Building'
Invoke-Native 'npm.cmd' @('run', 'build')

# -- Database -----------------------------------------------------------------
# A backup made on another machine with `gms db backup gms-backup.sqlite`,
# placed next to this installer, becomes the database - but only on a machine
# that has none yet, so an update can never overwrite real data.
$database = Join-Path $InstallDir 'data\gms.sqlite'
$backup = Join-Path (Split-Path -Parent $Self) 'gms-backup.sqlite'
if (-not (Test-Path $database) -and (Test-Path $backup)) {
  Step 'Using the database backup found next to the installer'
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $database) | Out-Null
  Copy-Item -Path $backup -Destination $database
}

Step 'Preparing the database'
Invoke-Native 'node' @('dist\cli\main.js', 'db', 'migrate')

# `gms` on PATH for anyone who prefers the terminal. Not essential.
& npm.cmd link --no-audit --no-fund *> $null

# -- Shortcuts ----------------------------------------------------------------
$shell = New-Object -ComObject WScript.Shell
function New-Shortcut([string]$path, [string]$target, [string]$description) {
  $link = $shell.CreateShortcut($path)
  $link.TargetPath = $target
  $link.WorkingDirectory = $InstallDir
  $link.Description = $description
  $link.Save()
}
$desktop = [Environment]::GetFolderPath('Desktop')
$dashboard = Join-Path $InstallDir 'scripts\windows\start-dashboard.cmd'
New-Shortcut (Join-Path $desktop 'GMS Dashboard.lnk') $dashboard 'Open the GMS dashboard'
New-Shortcut (Join-Path $desktop 'Update GMS.lnk') (Join-Path $InstallDir 'scripts\windows\install.cmd') 'Update GMS to the latest version'
# Start with Windows, so after the VPS restarts the dashboard is back on login.
New-Shortcut (Join-Path ([Environment]::GetFolderPath('Startup')) 'GMS Dashboard.lnk') $dashboard 'Start the GMS dashboard'

# -- Check --------------------------------------------------------------------
Step 'Checking that everything works'
& node dist\cli\main.js doctor --browser
if ($LASTEXITCODE -ne 0) {
  Write-Host ''
  Write-Host 'The check above reported a problem. GMS is installed, but read it before scraping.' -ForegroundColor Yellow
}

Write-Host ''
if ($fresh) { Write-Host 'GMS is installed.' -ForegroundColor Green }
else { Write-Host 'GMS is up to date.' -ForegroundColor Green }
Write-Host 'Double-click "GMS Dashboard" on the desktop to start.'
exit 0
