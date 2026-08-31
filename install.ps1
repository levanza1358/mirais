param(
  # Resolved before the UAC relaunch and forwarded to the elevated process:
  # elevation can switch to a different admin account, and $env:USERPROFILE
  # would then point at that account instead of the person installing.
  [string]$InstallDir
)

$ErrorActionPreference = 'Stop'

if (-not $InstallDir) {
  # Windows PowerShell 5.1 has no `??` operator — keep expressions 5.1-safe.
  $InstallDir = if ($env:MIRAIS_INSTALL_DIR) { $env:MIRAIS_INSTALL_DIR } else { Join-Path $env:USERPROFILE 'Mirais' }
}

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
  $process = Start-Process -FilePath $shell -Verb RunAs -Wait -PassThru -ArgumentList @(
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', "`"$scriptPath`"",
    '-InstallDir', "`"$InstallDir`""
  )
  if ($process.ExitCode -ne 0) {
    throw "Elevated installer failed with exit code $($process.ExitCode)."
  }
  Write-Output 'Installation completed by the elevated installer.'
  return
}

$RepoUrl = if ($env:MIRAIS_REPO_URL) { $env:MIRAIS_REPO_URL } else { 'https://github.com/levanza1358/mirais.git' }

function Test-ExecutableAvailable($name) {
  return [bool](Get-Command $name -ErrorAction SilentlyContinue)
}

Write-Output 'Installation in progress... please wait.'
if (-not (Test-ExecutableAvailable git)) {
  throw 'Git is required. Install Git for Windows first.'
}

if (-not (Test-ExecutableAvailable bun)) {
  powershell -ExecutionPolicy Bypass -c "irm bun.sh/install.ps1 | iex" | Out-Null
  $env:PATH = "$HOME\.bun\bin;$env:PATH"
}

if (Test-Path (Join-Path $InstallDir '.git')) {
  git -C $InstallDir pull --ff-only origin main | Out-Null
} else {
  if (Test-Path $InstallDir) { Remove-Item $InstallDir -Recurse -Force }
  git clone $RepoUrl $InstallDir | Out-Null
}

Set-Location $InstallDir

& bun install | Out-Null
Push-Location dashboard
& bun install | Out-Null
Pop-Location

if (Test-ExecutableAvailable py) {
  & py -3 -m venv '.venv'
} elseif (Test-ExecutableAvailable python) {
  & python -m venv '.venv'
} else {
  throw 'Python 3 is required for XAI Farm.'
}
$venvPython = Join-Path $InstallDir '.venv\Scripts\python.exe'
$env:PYTHONUTF8 = '1'
& $venvPython -m pip install -r 'scripts\xfarm\requirements.txt' | Out-Null
New-Item -ItemType Directory -Force -Path '.camoufox' | Out-Null
& $venvPython -c "import runpy,sys; from pathlib import Path; import camoufox.pkgman as p; p.INSTALL_DIR=Path(sys.argv[1]); sys.argv=['camoufox','fetch']; runpy.run_module('camoufox',run_name='__main__')" (Join-Path $InstallDir '.camoufox') | Out-Null

if (-not (Test-Path '.env')) {
  Copy-Item '.env.example' '.env'
}
New-Item -ItemType Directory -Force -Path 'data\backups' | Out-Null

& bun run build | Out-Null

# $env:ProgramData is always set on Windows, but stay 5.1-safe (no `??`).
$programData = if ($env:ProgramData) { $env:ProgramData } else { 'C:\ProgramData' }
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

try {
  & bun run scripts/extras.ts | Out-Null
} catch {
  # Optional helpers do not block installation.
  Write-Verbose "Optional helper installation failed: $($_.Exception.Message)"
}

Write-Output 'Installation successful. Check dashboard at http://localhost:1463'
