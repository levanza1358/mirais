param(
  # Resolved before the UAC relaunch and forwarded to the elevated process:
  # elevation can switch to a different admin account, and $env:USERPROFILE
  # would then point at that account instead of the person installing.
  [string]$InstallDir,
  # Opt-in wipe for a broken install: stops Mirais and its sidecars, removes
  # the launcher/autostart/install metadata, deletes the install directory
  # (including data), then performs a fresh clone. Destroys all local data.
  [switch]$ForceClean
)

$ErrorActionPreference = 'Stop'

if (-not $InstallDir) {
  # Windows PowerShell 5.1 has no `??` operator — keep expressions 5.1-safe.
  $InstallDir = if ($env:MIRAIS_INSTALL_DIR) { $env:MIRAIS_INSTALL_DIR } else { Join-Path $env:USERPROFILE 'Mirais' }
}

$installLog = if ((Test-Path $InstallDir) -and -not $ForceClean) {
  Join-Path $InstallDir 'install.log'
} else {
  Join-Path ([IO.Path]::GetTempPath()) ("mirais-install-{0}.log" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
}
$transcriptStarted = $false
try {
  Start-Transcript -Path $installLog -Append | Out-Null
  $transcriptStarted = $true
} catch {
  Write-Warning "Could not start installer log at $installLog`: $($_.Exception.Message)"
}

function Write-Step($message) {
  Write-Output "`n==> $message"
}

function Invoke-NativeStep($name, $filePath, [string[]]$arguments, $workingDirectory) {
  Write-Step $name
  if ($workingDirectory) { Push-Location $workingDirectory }
  try {
    & $filePath @arguments
    if ($LASTEXITCODE -ne 0) {
      throw "$name failed with exit code $LASTEXITCODE. See the installer log for details."
    }
  } finally {
    if ($workingDirectory) { Pop-Location }
  }
}

Write-Output "Installer log: $installLog"

function Test-Administrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  $administratorRole = [Security.Principal.WindowsBuiltInRole]::Administrator
  return $principal.IsInRole($administratorRole)
}

if (-not (Test-Administrator)) {
  $scriptPath = $PSCommandPath
  if (-not $scriptPath) {
    # `irm <url> | iex` has no script path, so persist the same installer first.
    $scriptPath = Join-Path ([IO.Path]::GetTempPath()) 'mirais-install.ps1'
    $installerUrl = if ($env:MIRAIS_INSTALLER_URL) {
      $env:MIRAIS_INSTALLER_URL
    } else {
      'https://raw.githubusercontent.com/levanza1358/mirais/main/install.ps1'
    }
    Invoke-WebRequest -UseBasicParsing -Uri $installerUrl -OutFile $scriptPath
  }

  Write-Output "Installing to $InstallDir"
  Write-Output 'Administrator access is required. Opening the Windows UAC prompt...'
  $shell = if ($PSVersionTable.PSEdition -eq 'Core') { 'pwsh.exe' } else { 'powershell.exe' }
  $elevationArgs = [System.Collections.Generic.List[string]]@(
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', "`"$scriptPath`"",
    '-InstallDir', "`"$InstallDir`""
  )
  if ($ForceClean) { $elevationArgs.Add('-ForceClean') }
  $process = Start-Process -FilePath $shell -Verb RunAs -Wait -PassThru -ArgumentList $elevationArgs.ToArray()
  if ($process.ExitCode -ne 0) {
    throw "Elevated installer failed with exit code $($process.ExitCode)."
  }
  Write-Output 'Installation completed by the elevated installer.'
  if ($transcriptStarted) { Stop-Transcript | Out-Null }
  return
}

$RepoUrl = if ($env:MIRAIS_REPO_URL) { $env:MIRAIS_REPO_URL } else { 'https://github.com/levanza1358/mirais.git' }
# $env:ProgramData is always set on Windows, but stay 5.1-safe (no `??`).
$programData = if ($env:ProgramData) { $env:ProgramData } else { 'C:\ProgramData' }

function Test-ExecutableAvailable($name) {
  return [bool](Get-Command $name -ErrorAction SilentlyContinue)
}

function Test-PythonCandidate($command, $arguments) {
  if (-not (Test-Path $command) -and -not (Test-ExecutableAvailable $command)) { return $false }
  try {
    $major = & $command @arguments -c 'import sys; print(sys.version_info.major)' 2>$null
    return $LASTEXITCODE -eq 0 -and "$major".Trim() -eq '3'
  } catch {
    return $false
  }
}

function Resolve-Python {
  $candidates = @()
  if ($env:MIRAIS_PYTHON) { $candidates += ,@($env:MIRAIS_PYTHON, @()) }
  $candidates += ,@('python', @())
  $candidates += ,@('python3', @())
  $candidates += ,@('py', @('-3'))

  foreach ($candidate in $candidates) {
    if (Test-PythonCandidate $candidate[0] $candidate[1]) {
      return @{ Command = $candidate[0]; Arguments = $candidate[1] }
    }
  }
  throw 'Python 3 is required for XAI Farm. Install Python 3 or set MIRAIS_PYTHON to a valid python.exe path.'
}

function Remove-IfExists($target, $description) {
  if (Test-Path $target) {
    Write-Output "  removing $description`: $target"
    Remove-Item $target -Recurse -Force
    if (Test-Path $target) { throw "Failed to remove $description`: $target" }
  }
}

if ($ForceClean) {
  Write-Step 'Removing the previous Mirais installation (-ForceClean)'
  Write-Warning 'This permanently deletes the existing Mirais database, logs, .env, and data/backups.'

  # Stop the gateway recorded in the pid file, then any leftover processes.
  $pidFile = Join-Path $InstallDir 'data\mirais.pid'
  if (Test-Path $pidFile) {
    $serverPid = [int](Get-Content $pidFile -Raw).Trim()
    Write-Output "  stopping Mirais server (pid $serverPid)"
    Stop-Process -Id $serverPid -Force -ErrorAction SilentlyContinue
  }
  Get-CimInstance Win32_Process -Filter "Name='bun.exe' OR Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine.Contains($InstallDir) } |
    ForEach-Object { Write-Output "  stopping leftover process (pid $($_.ProcessId))"; Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

  $startupLauncher = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup\Mirais.cmd'
  Remove-IfExists $startupLauncher 'Startup launcher'
  Remove-IfExists 'C:\Windows\mirais.cmd' 'global launcher'
  Remove-IfExists (Join-Path $programData 'Mirais') 'install metadata'
  Remove-IfExists $InstallDir 'install directory'
}

Write-Output 'Installation in progress. Each step will show its command output; long downloads may take several minutes.'
if (-not (Test-ExecutableAvailable git)) {
  throw 'Git is required. Install Git for Windows first.'
}

if (-not (Test-ExecutableAvailable bun)) {
  Invoke-NativeStep 'Installing Bun' 'powershell.exe' @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', 'irm bun.sh/install.ps1 | iex') $null
  $env:PATH = "$HOME\.bun\bin;$env:PATH"
}

if (Test-Path (Join-Path $InstallDir '.git')) {
  Invoke-NativeStep 'Updating the existing Git checkout' 'git.exe' @('-C', $InstallDir, 'pull', '--ff-only', '--progress', 'origin', 'main') $null
} else {
  if (Test-Path $InstallDir) {
    throw "Install directory exists but is not a Mirais Git checkout: $InstallDir. Refusing to delete it; choose another MIRAIS_INSTALL_DIR or back it up and remove it manually."
  }
  Invoke-NativeStep 'Cloning Mirais' 'git.exe' @('clone', '--progress', $RepoUrl, $InstallDir) $null
}

Set-Location $InstallDir

Invoke-NativeStep 'Installing backend dependencies' 'bun.exe' @('install') $InstallDir
Invoke-NativeStep 'Installing dashboard dependencies' 'bun.exe' @('install') (Join-Path $InstallDir 'dashboard')

$python = Resolve-Python
Invoke-NativeStep 'Creating the Python virtual environment' $python.Command (@($python.Arguments) + @('-m', 'venv', '.venv')) $InstallDir
$venvPython = Join-Path $InstallDir '.venv\Scripts\python.exe'
if (-not (Test-Path $venvPython)) { throw "Virtual environment was not created at $venvPython." }
$env:PYTHONUTF8 = '1'
Invoke-NativeStep 'Installing Python dependencies' $venvPython @('-m', 'pip', 'install', '-r', 'scripts\xfarm\requirements.txt') $InstallDir
New-Item -ItemType Directory -Force -Path '.camoufox' | Out-Null
Invoke-NativeStep 'Downloading the Camoufox browser' $venvPython @('-c', "import runpy,sys; from pathlib import Path; import camoufox.pkgman as p; p.INSTALL_DIR=Path(sys.argv[1]); sys.argv=['camoufox','fetch']; runpy.run_module('camoufox',run_name='__main__')", (Join-Path $InstallDir '.camoufox')) $InstallDir

if (-not (Test-Path '.env')) {
  Copy-Item '.env.example' '.env'
}
New-Item -ItemType Directory -Force -Path 'data\backups' | Out-Null

Invoke-NativeStep 'Building the dashboard' 'bun.exe' @('run', 'build') $InstallDir

$infoDir = Join-Path $programData 'Mirais'
New-Item -ItemType Directory -Force -Path $infoDir | Out-Null
Set-Content -Path (Join-Path $infoDir 'install.json') -Value (@{ root = $InstallDir } | ConvertTo-Json)
# The shim lives in C:\Windows (the one step that needs admin); everything else
# is per-user. It only forwards to the CLI, which resolves the install root
# from install.json — so the app itself never writes outside the user profile.
$shim = @(
  '@echo off'
  'setlocal'
  'cd /d "' + $InstallDir + '"'
  'bun run scripts/cli.ts %*'
) -join "`r`n"
Set-Content -Path 'C:\Windows\mirais.cmd' -Value $shim -Encoding Ascii

Write-Output "Installation successful. Check dashboard at http://localhost:1463"
Write-Output "For removal, see the Uninstall section in README.md. Installer log: $installLog"
if ($transcriptStarted) { Stop-Transcript | Out-Null }
