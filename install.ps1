param(
  [switch]$Elevated
)

$ErrorActionPreference = 'Stop'

function Test-Administrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
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

  Write-Host 'Administrator access is required. Opening the Windows UAC prompt...'
  $shell = if ($PSVersionTable.PSEdition -eq 'Core') { 'pwsh.exe' } else { 'powershell.exe' }
  $process = Start-Process -FilePath $shell -Verb RunAs -Wait -PassThru -ArgumentList @(
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', "`"$scriptPath`"",
    '-Elevated'
  )
  if ($process.ExitCode -ne 0) {
    throw "Elevated installer failed with exit code $($process.ExitCode)."
  }
  Write-Host 'Installation completed by the elevated installer.'
  return
}

$RepoUrl = if ($env:MIRAIS_REPO_URL) { $env:MIRAIS_REPO_URL } else { 'https://github.com/levanza1358/mirais.git' }
$InstallDir = if ($env:MIRAIS_INSTALL_DIR) { $env:MIRAIS_INSTALL_DIR } else { 'C:\Mirais' }

function Ensure-Command($name) {
  return [bool](Get-Command $name -ErrorAction SilentlyContinue)
}

Write-Host 'Installation in progress... please wait.'
if (-not (Ensure-Command git)) {
  throw 'Git is required. Install Git for Windows first.'
}

if (-not (Ensure-Command bun)) {
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

if (-not (Test-Path '.env')) {
  Copy-Item '.env.example' '.env'
}
New-Item -ItemType Directory -Force -Path 'data\backups' | Out-Null

& bun run build | Out-Null

$infoDir = Join-Path ($env:ProgramData ?? 'C:\ProgramData') 'Mirais'
New-Item -ItemType Directory -Force -Path $infoDir | Out-Null
Set-Content -Path (Join-Path $infoDir 'install.json') -Value (@{ root = $InstallDir } | ConvertTo-Json)
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
}

Write-Host 'Installation successful. Check dashboard at http://localhost:1463'