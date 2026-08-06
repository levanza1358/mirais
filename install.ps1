$ErrorActionPreference = 'Stop'

$RepoUrl = if ($env:MIRAIS_REPO_URL) { $env:MIRAIS_REPO_URL } else { 'https://github.com/levanza1358/mirais.git' }
$InstallDir = if ($env:MIRAIS_INSTALL_DIR) { $env:MIRAIS_INSTALL_DIR } else { 'C:\Mirais' }

function Ensure-Command($name) {
  return [bool](Get-Command $name -ErrorAction SilentlyContinue)
}

Write-Host '[mirais] checking prerequisites'
if (-not (Ensure-Command git)) {
  throw 'Git is required. Install Git for Windows first.'
}

if (-not (Ensure-Command bun)) {
  Write-Host '[mirais] installing Bun'
  powershell -ExecutionPolicy Bypass -c "irm bun.sh/install.ps1 | iex"
  $env:PATH = "$HOME\.bun\bin;$env:PATH"
}

Write-Host '[mirais] cloning/updating repo'
if (Test-Path (Join-Path $InstallDir '.git')) {
  git -C $InstallDir pull --ff-only origin main
} else {
  if (Test-Path $InstallDir) { Remove-Item $InstallDir -Recurse -Force }
  git clone $RepoUrl $InstallDir
}

Set-Location $InstallDir

Write-Host '[mirais] installing dependencies'
bun install
Push-Location dashboard
bun install
Pop-Location

Write-Host '[mirais] preparing environment'
if (-not (Test-Path '.env')) {
  Copy-Item '.env.example' '.env'
}
New-Item -ItemType Directory -Force -Path 'data\backups' | Out-Null

Write-Host '[mirais] building dashboard'
bun run build

Write-Host '[mirais] installing CLI shortcut'
$infoDir = Join-Path ($env:ProgramData ?? 'C:\ProgramData') 'Mirais'
New-Item -ItemType Directory -Force -Path $infoDir | Out-Null
Set-Content -Path (Join-Path $infoDir 'install.json') -Value (@{ root = $InstallDir } | ConvertTo-Json)
$shim = '@echo off`r`nsetlocal`r`ncd /d "' + $InstallDir + '"`r`nbun run scripts/cli.ts %*`r`n'
Set-Content -Path 'C:\Windows\mirais.cmd' -Value $shim

Write-Host ''
Write-Host 'Mirais installed. Next commands:'
Write-Host '  mirais start'
Write-Host '  mirais autostart on'
Write-Host '  mirais status'